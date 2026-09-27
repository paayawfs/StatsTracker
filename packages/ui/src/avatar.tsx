/** "Kwame Asante" -> "KA", "Kojo" -> "K". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0]![0]!;
  const last = parts.length > 1 ? parts[parts.length - 1]![0]! : '';
  return (first + last).toUpperCase();
}

/** Player photo, or initials on the team colour when there is none. Size in px. */
export function Avatar({ name, photo, team, size = 40 }: { name: string; photo?: string | null; team?: 'A' | 'B'; size?: number }) {
  const style = { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.4)}px` };
  return photo ? (
    <img class="avatar" src={photo} alt="" width={size} height={size} style={style} />
  ) : (
    <span class={`avatar initials${team ? ` team-${team}` : ''}`} style={style} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/**
 * Turn a picked image file into a small square WebP data URL (centre-cropped), small enough to
 * store with the player (the database caps photos at ~30 KB).
 */
export async function photoFromFile(file: File, size = 96): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  for (const quality of [0.82, 0.6, 0.4]) {
    const url = canvas.toDataURL('image/webp', quality);
    if (url.length <= 28_000) return url;
  }
  throw new Error('That image is too detailed to store; try a simpler photo.');
}
