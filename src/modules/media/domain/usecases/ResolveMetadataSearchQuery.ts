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
  /\b(audio|video|visuali[sz]er|m\/v|music video|official audio)\b/i,
  /\blyrics?\b/i,
  /\b(lyric video|color(?:\s|-)?coded|romanized)\b/i,
  /\b(letra|letras|subtit(?:le|ulo)s?|eng(?:lish)?\s+sub(?:titles?)?)\b/i,
  /\b(dance practice|choreography|performance video)\b/i,
  /\b(soundcloud|youtube|spotify|apple music|tiktok|vevo)\b/i,
  /\b(provided to youtube|topic|full song|hq|hd|4k)\b/i,
];

const labelMarkers = [
  /\b(entertainment|records?|music|labels?|soundcloud|vevo)\b/i,
  /\b(hybe|smtown|jyp|yg)\b/i,
  /vevo$/i,
];

const musicalVersionMarkers = [
  /\b(remaster(?:ed)?|live|acoustic|instrumental|sped\s*up|slowed|nightcore)\b/i,
];

const animeThemeMarkers = [
  /\b(?:op(?:ening)?|ed(?:ding)?)\s*#?\d{0,2}\b/i,
  /\b(?:opening|ending)\s+theme\b/i,
];

const featuredCreditPattern = /\s+(?:feat(?:\.|uring)?|ft\.?)\s+[^\s].*$/i;

const animePresentationMarkers = [
  /\b(?:traducid[ao]|sub(?:tit(?:le|ulo)s?)?|lyrics?|romaji|espa[nñ]ol|english)\b/i,
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

function removeInlineSourceSuffix(
  value: string,
  removedArtifacts: Set<string>,
): string {
  const match = sourceMarkers
    .map((pattern) => ({ pattern, match: pattern.exec(value) }))
    .filter((entry): entry is { pattern: RegExp; match: RegExpExecArray } =>
      entry.match != null,
    )
    .sort((left, right) => left.match.index - right.match.index)[0];
  if (!match || match.match.index <= 0) return value;

  const suffix = value.slice(match.match.index).trim();
  if (suffix) removedArtifacts.add(suffix);
  return value.slice(0, match.match.index).trim();
}

type EmbeddedCredits = {
  title: string;
  artist?: string;
  clearArtist?: boolean;
  matched?: boolean;
};

function hasAnimeThemeContext(value: string): boolean {
  return animeThemeMarkers.some((pattern) => pattern.test(value));
}

function cleanExtractedArtist(value: string): string | undefined {
  const withoutSourceSuffix = removeInlineSourceSuffix(value, new Set<string>());
  const cleaned = normalizeField(withoutSourceSuffix, new Set<string>(), {
    allowLabel: true,
  });
  if (!cleaned || isSourceArtifact(cleaned, { allowLabel: true })) {
    return undefined;
  }
  return cleaned;
}

function isAnimePresentation(value: string): boolean {
  return animePresentationMarkers.some((pattern) => pattern.test(value));
}

function extractAnimeThemeParts(value: string): EmbeddedCredits | undefined {
  const marker = animeThemeMarkers
    .map((pattern) => ({ match: pattern.exec(value) }))
    .find((entry) => entry.match != null)?.match;
  if (!marker) return undefined;

  const afterMarker = value
    .slice(marker.index + marker[0].length)
    .replace(/^[\s#:|—–-]+/, '')
    .trim();
  const byMatch = /^(.+?)\s+\bby\b\s+(.+)$/i.exec(afterMarker);
  if (byMatch) {
    const themeTitle = cleanInput(byMatch[1]);
    const extractedArtist = cleanExtractedArtist(byMatch[2]);
    if (themeTitle && extractedArtist) {
      return { title: themeTitle, artist: extractedArtist, matched: true };
    }
  }

  const parts = afterMarker
    .split(/\s+(?:[-|—–])\s+/)
    .map(cleanInput)
    .filter((part) => part && !isAnimePresentation(part));
  if (parts.length < 2) return undefined;

  const themeTitle = parts[0];
  const extractedArtist = cleanExtractedArtist(parts[1]);
  if (!themeTitle || !extractedArtist) return undefined;
  return { title: themeTitle, artist: extractedArtist, matched: true };
}

function removeFeaturedCreditFromEmbeddedTitle(value: string): string {
  return cleanInput(value.replace(featuredCreditPattern, '')) || value;
}

function extractAnimeCredits(
  title: string,
  artist: string,
  removedArtifacts: Set<string>,
): EmbeddedCredits {
  if (!hasAnimeThemeContext(title)) return { title };

  const withoutSourceSuffix = removeInlineSourceSuffix(title, removedArtifacts);
  const quotedMatch = /['\u2018\u2019\u201c\u201d「『]([^'\u2018\u2019\u201c\u201d」』]{1,160})['\u2018\u2019\u201c\u201d」』]/.exec(
    withoutSourceSuffix,
  );
  if (quotedMatch) {
    const embeddedTheme = extractAnimeThemeParts(quotedMatch[1]);
    if (embeddedTheme) {
      removedArtifacts.add('anime theme context');
      return embeddedTheme;
    }

    const themeTitle = cleanInput(quotedMatch[1]);
    const trailing = withoutSourceSuffix.slice(
      quotedMatch.index + quotedMatch[0].length,
    );
    const trailingArtist = /\bby\b\s+(.+)$/i.exec(trailing)?.[1];
    const extractedArtist = trailingArtist
      ? cleanExtractedArtist(trailingArtist)
      : undefined;
    if (themeTitle) {
      removedArtifacts.add('anime theme context');
      return {
        title: themeTitle,
        ...(extractedArtist
          ? { artist: extractedArtist }
          : isSourceArtifact(artist, { allowLabel: true })
          ? { clearArtist: true }
          : { artist }),
        matched: true,
      };
    }
  }

  const extractedTheme = extractAnimeThemeParts(withoutSourceSuffix);
  if (extractedTheme) {
    removedArtifacts.add('anime theme context');
    return extractedTheme;
  }
  return { title };
}

function extractEmbeddedCredits(
  title: string,
  artist: string,
  removedArtifacts: Set<string>,
): EmbeddedCredits {
  const withoutSourceSuffix = removeInlineSourceSuffix(title, removedArtifacts);
  const match = /^(.{1,100}?)\s+['\u2018\u2019\u201c\u201d]([^'\u2018\u2019\u201c\u201d]{1,160})['\u2018\u2019\u201c\u201d]/.exec(
    withoutSourceSuffix,
  );
  if (!match) return { title: withoutSourceSuffix };

  const embeddedArtist = cleanInput(match[1]);
  const embeddedTitle = cleanInput(match[2]);
  if (!embeddedArtist || !embeddedTitle || !isSourceArtifact(artist, { allowLabel: true })) {
    return { title: withoutSourceSuffix };
  }

  removedArtifacts.add(`embedded artist: ${embeddedArtist}`);
  return { title: embeddedTitle, artist: embeddedArtist };
}

function isLikelyMusicalVersion(value: string): boolean {
  return musicalVersionMarkers.some((pattern) => pattern.test(value));
}

function extractDelimitedCredits(
  title: string,
  artist: string,
  removedArtifacts: Set<string>,
): EmbeddedCredits {
  if (!isSourceArtifact(artist, { allowLabel: true })) return { title };

  const separator = /\s+(?:[-|—–])\s+/;
  const firstSeparator = separator.exec(title);
  if (!firstSeparator || firstSeparator.index <= 0) return { title };

  const embeddedArtist = cleanInput(title.slice(0, firstSeparator.index));
  const embeddedTitle = cleanInput(
    title.slice(firstSeparator.index + firstSeparator[0].length),
  );
  if (
    !embeddedArtist ||
    !embeddedTitle ||
    isLikelyMusicalVersion(embeddedTitle)
  ) {
    return { title };
  }

  removedArtifacts.add(`embedded artist: ${embeddedArtist}`);
  return { title: embeddedTitle, artist: embeddedArtist };
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
    const animeCredits = extractAnimeCredits(
      normalizedTitle,
      normalizedArtist,
      removedArtifacts,
    );
    const quotedCredits = animeCredits.matched
      ? animeCredits
      : extractEmbeddedCredits(
          normalizedTitle,
          normalizedArtist,
          removedArtifacts,
        );
    const delimitedCredits = quotedCredits.matched || quotedCredits.artist
      ? quotedCredits
      : extractDelimitedCredits(
          quotedCredits.title,
          normalizedArtist,
          removedArtifacts,
        );
    const extractedFromVideoTitle =
      delimitedCredits.matched || delimitedCredits.artist != null;
    const resolvedTitle = extractedFromVideoTitle
      ? removeFeaturedCreditFromEmbeddedTitle(delimitedCredits.title) ||
          normalizedTitle
      : delimitedCredits.title || normalizedTitle;
    const resolvedArtist = delimitedCredits.clearArtist
      ? ''
      : delimitedCredits.artist || normalizedArtist;
    const changedCharacters =
      Math.max(0, title.length - resolvedTitle.length) +
      Math.max(0, artist.length - resolvedArtist.length);
    const originalLength = Math.max(1, title.length + artist.length);
    const confidence = Math.round(
      Math.max(0.55, Math.min(0.99, 0.76 + (changedCharacters / originalLength) * 0.2)) *
        100,
    ) / 100;

    const localResult: MetadataSearchQueryResult = {
      query: {
        title: resolvedTitle,
        artist: resolvedArtist,
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
      title: resolvedTitle,
      artist: resolvedArtist,
    })) {
      const identity = `${comparable(candidate.title)}|${comparable(candidate.artist)}`;
      const known = candidateByIdentity.get(identity);
      if (!known || candidate.rank > known.rank) {
        candidateByIdentity.set(identity, candidate);
      }
    }
    const ranked = Array.from(candidateByIdentity.values())
      .map((candidate) => rankCandidate(candidate, {
        title: resolvedTitle,
        artist: resolvedArtist,
        durationSeconds: input.durationSeconds,
      }))
      .sort((left, right) => right.score - left.score);
    const winner = ranked[0];
    const runnerUp = ranked[1];
    const hasClearWinner =
      winner &&
      winner.score >=
        (resolvedArtist
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
