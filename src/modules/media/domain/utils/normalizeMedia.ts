interface NormalizeInput {
  title: string;
  artist: string;
}

export function normalizeMediaInfo(
  input: NormalizeInput
): {
  title: string;
  artist: string;
  extras?: string[];
} {

  let title = input.title;
  let artist = input.artist;
  const extras: string[] = [];

  // 🎵 Caso típico: "ARTISTA - CANCIÓN (algo)"
  if (title.includes(' - ')) {
    const parts = title.split(' - ');
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ').trim();
  }

  // 🧹 Extraer paréntesis: (Sub Español, Lyrics, etc.)
  const match = title.match(/\(([^)]+)\)/);
  if (match) {
    extras.push(
      ...match[1].split(/[+,]/).map(e => e.trim())
    );
    title = title.replace(match[0], '').trim();
  }

  return {
    title,
    artist,
    extras: extras.length ? extras : undefined
  };
}
