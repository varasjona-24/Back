import {
  DeezerMetadataSearchSource,
  type DeezerTrackCandidate,
} from '../../infra/metadata/DeezerMetadataSearchSource.js';

export type MetadataSearchQueryInput = {
  title: string;
  artist: string;
  durationSeconds?: number;
};

export type MetadataSearchQueryResult = {
  query: {
    title: string;
    artist: string;
  };
  fallback: {
    title: string;
    artist: string;
  };
  confidence: number;
  removedArtifacts: string[];
  resolvedBy?: 'deezer';
  durationSeconds?: number;
};

const maxMetadataLength = 300;
const acceptedCandidateScore = 0.79;
const acceptedTitleOnlyCandidateScore = 0.86;
const acceptedScoreMargin = 0.075;

const sourceMarkers = [
  /\bofficial\b/i,
  /\b(audio|video|visuali[sz]er)\b/i,
  /\blyrics?\b/i,
  /\blyric video\b/i,
  /\b(letra|letras|subtit(?:le|ulo)s?)\b/i,
  /\b(soundcloud|youtube|spotify|apple music|tiktok|vevo)\b/i,
  /\b(provided to youtube|topic|full song|hq|hd|4k)\b/i,
];

const labelMarkers = [
  /\b(entertainment|records?|music|label|soundcloud|vevo)\b/i,
];

function cleanInput(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxMetadataLength);
}

function isSourceArtifact(value: string, { allowLabel }: { allowLabel: boolean }): boolean {
  return sourceMarkers.some((pattern) => pattern.test(value)) ||
    (allowLabel && labelMarkers.some((pattern) => pattern.test(value)));
}

function removeMarkedGroups(
  value: string,
  removedArtifacts: Set<string>,
  options: { allowLabel: boolean },
): string {
  return value.replace(/\[[^\]]{1,160}\]|\([^)]{1,160}\)|\{[^}]{1,160}\}/g, (group) => {
    const content = group.slice(1, -1).trim();
    if (!isSourceArtifact(content, options)) return group;
    removedArtifacts.add(content);
    return ' ';
  });
}

function removeTrailingArtifacts(
  value: string,
  removedArtifacts: Set<string>,
  options: { allowLabel: boolean },
): string {
  const segments = value.split(/\s+(?:[-|—–])\s+/);
  while (segments.length > 1) {
    const trailing = segments[segments.length - 1].trim();
    if (!isSourceArtifact(trailing, options)) break;
    removedArtifacts.add(trailing);
    segments.pop();
  }
  return segments.join(' - ');
}

function normalizeField(
  raw: string,
  removedArtifacts: Set<string>,
  options: { allowLabel: boolean },
): string {
  const withoutGroups = removeMarkedGroups(raw, removedArtifacts, options);
  const withoutTrailing = removeTrailingArtifacts(
    withoutGroups,
    removedArtifacts,
    options,
  );
  return cleanInput(withoutTrailing.replace(/\s+[-|—–:]\s*$/, ''));
}

function comparable(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function diceSimilarity(left: string, right: string): number {
  const a = comparable(left).replace(/\s/g, '');
  const b = comparable(right).replace(/\s/g, '');
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const pairs = new Map<string, number>();
  for (let index = 0; index < a.length - 1; index += 1) {
    const pair = a.slice(index, index + 2);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }

  let intersection = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const pair = b.slice(index, index + 2);
    const available = pairs.get(pair) ?? 0;
    if (available <= 0) continue;
    pairs.set(pair, available - 1);
    intersection += 1;
  }
  return (2 * intersection) / ((a.length - 1) + (b.length - 1));
}

function durationSimilarity(expected?: number, actual?: number): number {
  if (!expected || !actual) return 0.5;
  const delta = Math.abs(expected - actual);
  if (delta <= 2) return 1;
  if (delta >= 20) return 0;
  return 1 - ((delta - 2) / 18);
}

function popularityScore(rank: number): number {
  if (rank <= 0) return 0;
  return Math.min(1, Math.log10(rank + 1) / 7);
}

type RankedCandidate = {
  candidate: DeezerTrackCandidate;
  score: number;
};

function rankCandidate(
  candidate: DeezerTrackCandidate,
  input: { title: string; artist: string; durationSeconds?: number },
): RankedCandidate {
  const titleScore = diceSimilarity(input.title, candidate.title);
  const artistScore = diceSimilarity(input.artist, candidate.artist);
  const durationScore = durationSimilarity(input.durationSeconds, candidate.durationSeconds);
  const score = input.artist
    ? (titleScore * 0.54) +
      (artistScore * 0.3) +
      (durationScore * 0.12) +
      (popularityScore(candidate.rank) * 0.04)
    : (titleScore * 0.78) +
      (durationScore * 0.16) +
      (popularityScore(candidate.rank) * 0.06);
  return { candidate, score };
}

export class ResolveMetadataSearchQuery {
  constructor(
    private readonly deezer = new DeezerMetadataSearchSource(),
  ) {}

  async execute(input: MetadataSearchQueryInput): Promise<MetadataSearchQueryResult> {
    const title = cleanInput(input.title);
    const artist = cleanInput(input.artist);
    const removedArtifacts = new Set<string>();

    const normalizedTitle = normalizeField(title, removedArtifacts, {
      allowLabel: false,
    }) || title;
    const normalizedArtist = normalizeField(artist, removedArtifacts, {
      allowLabel: true,
    }) || artist;
    const changedCharacters =
      Math.max(0, title.length - normalizedTitle.length) +
      Math.max(0, artist.length - normalizedArtist.length);
    const originalLength = Math.max(1, title.length + artist.length);
    const confidence = Math.round(
      Math.max(0.55, Math.min(0.99, 0.76 + (changedCharacters / originalLength) * 0.2)) *
        100,
    ) / 100;

    const localResult: MetadataSearchQueryResult = {
      query: {
        title: normalizedTitle,
        artist: normalizedArtist,
      },
      fallback: { title, artist },
      confidence,
      removedArtifacts: Array.from(removedArtifacts),
      ...(Number.isFinite(input.durationSeconds) &&
      (input.durationSeconds ?? 0) > 0
        ? { durationSeconds: Math.round(input.durationSeconds!) }
        : {}),
    };

    const candidateByIdentity = new Map<string, DeezerTrackCandidate>();
    for (const candidate of await this.deezer.search({
      title: normalizedTitle,
      artist: normalizedArtist,
    })) {
      const identity = `${comparable(candidate.title)}|${comparable(candidate.artist)}`;
      const known = candidateByIdentity.get(identity);
      if (!known || candidate.rank > known.rank) {
        candidateByIdentity.set(identity, candidate);
      }
    }
    const ranked = Array.from(candidateByIdentity.values())
      .map((candidate) => rankCandidate(candidate, {
        title: normalizedTitle,
        artist: normalizedArtist,
        durationSeconds: input.durationSeconds,
      }))
      .sort((left, right) => right.score - left.score);
    const winner = ranked[0];
    const runnerUp = ranked[1];
    const hasClearWinner =
      winner &&
      winner.score >=
        (normalizedArtist
          ? acceptedCandidateScore
          : acceptedTitleOnlyCandidateScore) &&
      (!runnerUp || (winner.score - runnerUp.score) >= acceptedScoreMargin);
    if (!hasClearWinner) return localResult;

    return {
      ...localResult,
      query: {
        title: winner.candidate.title,
        artist: winner.candidate.artist,
      },
      confidence: Math.round(winner.score * 100) / 100,
      resolvedBy: 'deezer',
    };
  }
}
