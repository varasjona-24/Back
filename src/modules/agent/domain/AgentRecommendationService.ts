import { mediaLibrary } from '../../media/domain/library/index.js';
import type { NormalizedMediaInfo } from '../../media/domain/usecases/types.js';

type AnyMap = Record<string, unknown>;

type TrackCandidate = {
  id: string;
  publicId: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string | null;
  source: string;
  hasAudio: boolean;
  hasVideo: boolean;
  playCount: number;
  skipCount: number;
  fullListenCount: number;
  avgListenProgress: number;
  isFavorite: boolean;
  lastPlayedAt?: number;
  lastCompletedAt?: number;
  originKey: string;
  artistKey: string;
  genres: string[];
};

const stationTypes = ['essentials', 'discovery', 'gateway', 'energy', 'chill'] as const;

const regionCatalog = [
  { code: 'latam', name: 'Latinoamérica', regionKey: 'america' },
  { code: 'caribbean', name: 'Caribe', regionKey: 'america' },
  { code: 'north-america', name: 'Norteamérica', regionKey: 'america' },
  { code: 'brazil', name: 'Brasil', regionKey: 'america' },
  { code: 'iberia', name: 'Iberia', regionKey: 'europe' },
  { code: 'europe', name: 'Europa', regionKey: 'europe' },
  { code: 'africa', name: 'África', regionKey: 'africa' },
  { code: 'asia', name: 'Asia', regionKey: 'asia' },
] as const;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const id = String(raw ?? '').trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

function stableHash(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeId(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const genreLexicon: Record<string, string[]> = {
  pop: ['pop', 'dance pop', 'latin pop'],
  reggaeton: ['reggaeton', 'urbano', 'dembow'],
  rock: ['rock', 'alt rock', 'indie rock'],
  rap: ['rap', 'hip hop', 'trap'],
  electronic: ['electronic', 'edm', 'house', 'techno'],
  ballad: ['balada', 'ballad', 'romantica'],
  regional: ['regional', 'corridos', 'banda', 'vallenato'],
  rnb: ['r&b', 'rnb', 'soul'],
};

function inferGenres(track: Pick<TrackCandidate, 'title' | 'artist' | 'source' | 'originKey'>): string[] {
  const text = normalizeKey(`${track.title} ${track.artist} ${track.source} ${track.originKey}`).replace(/-/g, ' ');
  const out: string[] = [];
  for (const [genre, aliases] of Object.entries(genreLexicon)) {
    if (aliases.some((alias) => text.includes(normalizeKey(alias).replace(/-/g, ' ')))) out.push(genre);
  }
  return out;
}

function rankedTracks(
  tracks: TrackCandidate[],
  seed: string,
  exclude: Set<string>,
  limit: number,
): TrackCandidate[] {
  return tracks
    .filter((track) => track.publicId && !exclude.has(track.publicId) && !exclude.has(track.id))
    .map((track) => ({ track, score: stableHash(`${seed}:${track.publicId}:${track.id}`) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((entry) => entry.track);
}

function pickCandidateIds(payload: AnyMap): string[] {
  const direct = asStringArray(payload.candidateTrackIds)
    .concat(asStringArray(payload.availableTrackIds))
    .concat(asStringArray(payload.trackPublicIds))
    .concat(asStringArray(payload.trackIds));
  const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
  for (const raw of tracks) {
    if (!raw || typeof raw !== 'object') continue;
    const map = raw as AnyMap;
    const id = asString(map.publicId) || asString(map.id) || asString(map.itemId);
    if (id && !direct.includes(id)) direct.push(id);
  }
  return direct;
}

function toCandidate(media: NormalizedMediaInfo): TrackCandidate {
  const variants = Array.isArray(media.variants) ? media.variants : [];
  return {
    id: media.id,
    publicId: media.publicId || media.id,
    title: media.title,
    artist: media.artist,
    duration: media.duration,
    thumbnail: media.thumbnail,
    source: media.source,
    hasAudio: variants.some((variant) => variant.kind === 'audio'),
    hasVideo: variants.some((variant) => variant.kind === 'video'),
    playCount: 0,
    skipCount: 0,
    fullListenCount: 0,
    avgListenProgress: 0,
    isFavorite: false,
    originKey: media.source,
    artistKey: normalizeKey(media.artist),
    genres: [],
  };
}

function trackPayload(track: TrackCandidate) {
  return {
    id: track.id,
    publicId: track.publicId,
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    thumbnail: track.thumbnail,
    source: track.source,
  };
}

function libraryCandidates(mode: 'audio' | 'video' | 'any' = 'audio'): TrackCandidate[] {
  return mediaLibrary
    .getAll()
    .map(toCandidate)
    .filter((track) => {
      if (mode === 'audio') return track.hasAudio;
      if (mode === 'video') return track.hasVideo;
      return track.hasAudio || track.hasVideo;
    });
}

function candidatesFromPayload(payload: AnyMap, mode: 'audio' | 'video' | 'any' = 'audio'): TrackCandidate[] {
  const byId = new Map<string, TrackCandidate>();
  for (const track of libraryCandidates(mode)) {
    byId.set(track.id, track);
    byId.set(track.publicId, track);
  }

  const out: TrackCandidate[] = [];
  const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
  for (const raw of tracks) {
    if (!raw || typeof raw !== 'object') continue;
    const map = raw as AnyMap;
    const id = asString(map.id) || asString(map.itemId) || asString(map.publicId);
    const publicId = asString(map.publicId) || id;
    if (!id && !publicId) continue;
    const found = byId.get(publicId) ?? byId.get(id);
    const title = asString(map.title) || found?.title || '';
    const artist = asString(map.artist) || asString(map.subtitle) || found?.artist || '';
    const candidate: TrackCandidate = {
      ...(found ?? {
        id: id || publicId,
        publicId: publicId || id,
        title,
        artist,
        duration: asNumber(map.durationSeconds) || asNumber(map.duration) || 0,
        thumbnail: asString(map.thumbnail) || null,
        source: asString(map.source) || 'client',
        hasAudio: mode !== 'video',
        hasVideo: mode !== 'audio',
        playCount: 0,
        skipCount: 0,
        fullListenCount: 0,
        avgListenProgress: 0,
        isFavorite: false,
        originKey: asString(map.originKey) || asString(map.origin) || 'client',
        artistKey: normalizeKey(artist),
        genres: [],
      }),
      playCount: asNumber(map.playCount, found?.playCount ?? 0),
      skipCount: asNumber(map.skipCount, found?.skipCount ?? 0),
      fullListenCount: asNumber(map.fullListenCount, found?.fullListenCount ?? 0),
      avgListenProgress: Math.max(0, Math.min(1, asNumber(map.avgListenProgress, found?.avgListenProgress ?? 0))),
      isFavorite: asBool(map.isFavorite) || found?.isFavorite === true,
      lastPlayedAt: asNumber(map.lastPlayedAt, found?.lastPlayedAt ?? 0) || undefined,
      lastCompletedAt: asNumber(map.lastCompletedAt, found?.lastCompletedAt ?? 0) || undefined,
      originKey: asString(map.originKey) || asString(map.origin) || found?.originKey || 'client',
      artistKey: normalizeKey(asString(map.artistKey) || artist || found?.artistKey || ''),
      genres: asStringArray(map.genres),
    };
    candidate.genres = candidate.genres.length > 0 ? candidate.genres : inferGenres(candidate);
    if (out.some((entry) => entry.publicId === candidate.publicId || entry.id === candidate.id)) continue;
    out.push(candidate);
  }

  for (const id of pickCandidateIds(payload)) {
    const key = normalizeId(id);
    if (!key) continue;
    const found = byId.get(key);
    const candidate = found ?? {
      id: key,
      publicId: key,
      title: '',
      artist: '',
      duration: 0,
      thumbnail: null,
      source: 'client',
      hasAudio: mode !== 'video',
      hasVideo: mode !== 'audio',
      playCount: 0,
      skipCount: 0,
      fullListenCount: 0,
      avgListenProgress: 0,
      isFavorite: false,
      originKey: 'client',
      artistKey: '',
      genres: [],
    };
    if (out.some((entry) => entry.publicId === candidate.publicId || entry.id === candidate.id)) continue;
    out.push(candidate);
  }

  const fallback = out.length > 0 ? out : libraryCandidates(mode);
  for (const candidate of fallback) {
    if (candidate.genres.length === 0) candidate.genres = inferGenres(candidate);
  }
  return fallback;
}

function recentScore(timestamp: number | undefined, now: number): number {
  if (!timestamp || timestamp <= 0) return 0;
  const ageDays = Math.max(0, (now - timestamp) / 86_400_000);
  return Math.exp(-ageDays / 14);
}

function completionRate(track: TrackCandidate): number {
  const total = track.fullListenCount + track.skipCount;
  if (total <= 0) return Math.max(0, Math.min(1, track.avgListenProgress));
  return Math.max(0, Math.min(1, track.fullListenCount / total));
}

function buildProfile(tracks: TrackCandidate[], now: number) {
  const artists = new Map<string, number>();
  const genres = new Map<string, number>();
  const origins = new Map<string, number>();

  for (const track of tracks) {
    const retention = completionRate(track);
    const recency = recentScore(track.lastPlayedAt, now);
    const weight =
      (track.isFavorite ? 3.4 : 0) +
      Math.min(track.playCount, 40) * 0.13 +
      Math.min(track.fullListenCount, 30) * 0.18 +
      retention * 1.4 +
      recency * 1.7 -
      Math.min(track.skipCount, 20) * 0.08;
    if (weight <= 0.15) continue;
    if (track.artistKey) artists.set(track.artistKey, (artists.get(track.artistKey) ?? 0) + weight);
    if (track.originKey) origins.set(track.originKey, (origins.get(track.originKey) ?? 0) + weight * 0.55);
    for (const genre of track.genres) genres.set(genre, (genres.get(genre) ?? 0) + weight * 0.8);
  }

  const normalize = (map: Map<string, number>) => {
    const max = Math.max(1, ...map.values());
    return map;
  };

  return {
    artists: normalize(artists),
    genres: normalize(genres),
    origins: normalize(origins),
    strength: Math.max(0, ...artists.values(), ...genres.values(), ...origins.values()),
  };
}

function mapSignal(map: Map<string, number>, key: string): number {
  if (!key) return 0;
  const max = Math.max(1, ...map.values());
  return Math.max(0, Math.min(1, (map.get(key) ?? 0) / max));
}

function scoreDailyTracks(tracks: TrackCandidate[], seed: string, exclude: Set<string>, limit: number) {
  const now = Date.now();
  const profile = buildProfile(tracks, now);
  const coldStart = profile.strength < 1.2;

  const scored = tracks
    .filter((track) => track.publicId && !exclude.has(track.publicId) && !exclude.has(track.id))
    .map((track) => {
      const play = Math.min(track.playCount / 30, 1);
      const skips = Math.min(track.skipCount / 20, 1);
      const retention = (completionRate(track) * 0.65) + (track.avgListenProgress * 0.35);
      const recency = recentScore(track.lastPlayedAt, now);
      const completedRecency = recentScore(track.lastCompletedAt, now);
      const artistMatch = mapSignal(profile.artists, track.artistKey);
      const originMatch = mapSignal(profile.origins, track.originKey);
      const genreMatch = Math.max(0, ...track.genres.map((genre) => mapSignal(profile.genres, genre)));
      const semantic = (artistMatch * 0.46) + (genreMatch * 0.34) + (originMatch * 0.20);
      const engagement =
        (track.isFavorite ? 0.28 : 0) +
        (play * 0.20) +
        (retention * 0.24) +
        (recency * 0.14) +
        (completedRecency * 0.14);
      const novelty =
        (1 - Math.min((track.playCount + track.fullListenCount) / 36, 1)) * 0.65 +
        (!track.lastPlayedAt ? 0.22 : 0) +
        (stableHash(`${seed}:novelty:${track.publicId}`) / 0xffffffff) * 0.13;
      const exploration = (semantic * 0.58) + (novelty * 0.42);
      const base = coldStart
        ? (engagement * 0.28) + (exploration * 0.72)
        : (engagement * 0.48) + (semantic * 0.34) + (novelty * 0.18);
      const jitter = (stableHash(`${seed}:jitter:${track.publicId}`) / 0xffffffff) * 0.08;
      const score = Math.max(0, Math.min(1, (base + jitter) * (1 - skips * 0.42)));
      const reasonCode = semantic >= 0.5
        ? (artistMatch >= genreMatch ? 'artist_affinity' : 'genre_match')
        : recency >= 0.45
          ? 'recent_affinity'
          : track.isFavorite
            ? 'favorite_affinity'
            : 'fresh_pick';
      const reasonText = reasonCode === 'artist_affinity'
        ? `Por tu afinidad con ${track.artist || 'este artista'}`
        : reasonCode === 'genre_match'
          ? 'Por estilos que escuchas bastante'
          : reasonCode === 'recent_affinity'
            ? 'Relacionado con escuchas recientes'
            : reasonCode === 'favorite_affinity'
              ? 'Por tus favoritos'
              : 'Selección fresca para hoy';
      return { track, score, reasonCode, reasonText };
    })
    .sort((a, b) => b.score - a.score);

  const selected: typeof scored = [];
  const deferred: typeof scored = [];
  const artistCount = new Map<string, number>();
  const originCount = new Map<string, number>();
  const genreCount = new Map<string, number>();
  const maxArtist = Math.max(2, Math.ceil(limit * 0.08));
  const maxOrigin = Math.max(6, Math.ceil(limit * 0.30));
  const maxGenre = Math.max(5, Math.ceil(limit * 0.16));

  for (const entry of scored) {
    if (selected.length >= limit) break;
    const artist = entry.track.artistKey;
    const origin = entry.track.originKey;
    const genre = entry.track.genres[0] ?? '';
    const blocked =
      (artist && (artistCount.get(artist) ?? 0) >= maxArtist) ||
      (origin && (originCount.get(origin) ?? 0) >= maxOrigin) ||
      (genre && (genreCount.get(genre) ?? 0) >= maxGenre);
    if (blocked) {
      deferred.push(entry);
      continue;
    }
    selected.push(entry);
    if (artist) artistCount.set(artist, (artistCount.get(artist) ?? 0) + 1);
    if (origin) originCount.set(origin, (originCount.get(origin) ?? 0) + 1);
    if (genre) genreCount.set(genre, (genreCount.get(genre) ?? 0) + 1);
  }

  for (const entry of deferred) {
    if (selected.length >= limit) break;
    selected.push(entry);
  }
  return selected.slice(0, limit);
}

export class AgentRecommendationService {
  countries() {
    const audioCount = libraryCandidates('audio').length;
    return regionCatalog.map((region) => ({
      ...region,
      discoveryCount: audioCount,
    }));
  }

  exploreCountry(payload: AnyMap) {
    const region = (asString(payload.region) || asString(payload.country) || 'global').toLowerCase();
    const context = (payload.context && typeof payload.context === 'object')
      ? payload.context as AnyMap
      : {};
    const tracksPerStation = Math.max(8, Math.min(80, Number(context.tracksPerStation ?? 30) || 30));
    const maxStations = Math.max(1, Math.min(5, Number(context.maxStations ?? 5) || 5));
    const candidates = candidatesFromPayload(payload, 'audio');
    const recent = new Set(asStringArray(payload.recentTrackIds));

    const stations = stationTypes.slice(0, maxStations).map((type, index) => {
      const tracks = rankedTracks(candidates, `${region}:${type}:${index}`, recent, tracksPerStation);
      const ids = tracks.map((track) => track.publicId);
      return {
        stationId: `${region}-${type}`,
        type,
        title: this.stationTitle(type),
        subtitle: ids.length > 0
          ? 'Curada con señales locales y rotación remota.'
          : 'Base remota lista; el cliente usará mezcla local si no hay candidatos.',
        trackPublicIds: ids,
        tracks: tracks.map(trackPayload),
        ttlSec: 21600,
      };
    });

    return {
      country: region,
      region,
      generatedAtMs: Date.now(),
      stations,
    };
  }

  continueStation(payload: AnyMap) {
    const stationId = asString(payload.stationId) || 'station';
    const region = (asString(payload.region) || asString(payload.country) || 'global').toLowerCase();
    const limit = Math.max(4, Math.min(80, Number(payload.limit ?? 20) || 20));
    const played = new Set(asStringArray(payload.playedTrackIds));
    const recent = new Set(asStringArray(payload.recentTrackIds));
    const exclude = new Set([...played, ...recent]);
    const tracks = rankedTracks(
      candidatesFromPayload(payload, 'audio'),
      `${region}:${stationId}:continue`,
      exclude,
      limit,
    );
    const trackPublicIds = tracks.map((track) => track.publicId);

    return {
      stationId,
      region,
      trackPublicIds,
      tracks: tracks.map(trackPayload),
      generatedAtMs: Date.now(),
    };
  }

  dailyRecommendations(payload: AnyMap) {
    const mode = asString(payload.mode) === 'video' ? 'video' : 'audio';
    const dateKey = asString(payload.dateKey) || new Date().toISOString().slice(0, 10);
    const limit = Math.max(8, Math.min(100, Number(payload.limit ?? 40) || 40));
    const candidates = candidatesFromPayload(payload, mode);
    const hidden = new Set(asStringArray(payload.hiddenTrackIds));
    const recent = new Set(asStringArray(payload.recentTrackIds));
    const exclude = new Set([...hidden]);
    const selected = scoreDailyTracks(candidates, `${dateKey}:${mode}:daily`, exclude, limit);

    const entries = selected.map((entry) => ({
      itemId: entry.track.id,
      publicId: entry.track.publicId,
      score: entry.score,
      reasonCode: recent.has(entry.track.publicId) || recent.has(entry.track.id)
        ? 'recent_affinity'
        : entry.reasonCode,
      reasonText: recent.has(entry.track.publicId) || recent.has(entry.track.id)
        ? 'Relacionado con escuchas recientes'
        : entry.reasonText,
      generatedAt: Date.now(),
      track: trackPayload(entry.track),
    }));

    return {
      dateKey,
      mode,
      entries,
      generatedAtMs: Date.now(),
    };
  }

  private stationTitle(type: typeof stationTypes[number]): string {
    switch (type) {
      case 'essentials': return 'Esenciales';
      case 'gateway': return 'Puerta de entrada';
      case 'energy': return 'Alta energía';
      case 'chill': return 'Chill regional';
      case 'discovery':
      default: return 'Descubrimiento';
    }
  }
}
