import type { SourcePlugin } from "../plugins/source-plugin";
import { SourceFavicon } from "./source-favicon";

type ConnectedSourceLike = {
  readonly id: string;
  readonly name: string;
  readonly url?: string;
};

const STOP_WORDS = new Set([
  "api",
  "apis",
  "builtin",
  "built",
  "control",
  "discovery",
  "google",
  "rest",
  "source",
  "tool",
  "v1",
  "v2",
  "v3",
  "v4",
  "v5",
  "v6",
  "v7",
  "v8",
  "v9",
  "v10",
]);

const tokenize = (value: string): readonly string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));

const normalizeForMatch = (value: string): string => tokenize(value).join(" ");

const findPresetIcon = (
  source: ConnectedSourceLike,
  plugin?: SourcePlugin,
): string | null => {
  const presets = plugin?.presets ?? [];
  if (presets.length === 0) return null;

  const normalizedSourceId = normalizeForMatch(source.id);
  const normalizedSourceName = normalizeForMatch(source.name);
  const sourceTokens = new Set(
    [...tokenize(source.id), ...tokenize(source.name), ...tokenize(source.url ?? "")],
  );

  let bestMatch: { readonly icon: string; readonly score: number } | null = null;

  for (const preset of presets) {
    if (!preset.icon) continue;

    const normalizedPresetId = normalizeForMatch(preset.id);
    const normalizedPresetName = normalizeForMatch(preset.name);
    const presetTokens = Array.from(new Set([...tokenize(preset.id), ...tokenize(preset.name)]));

    let score = 0;

    if (preset.url && source.url && preset.url === source.url) score += 100;

    if (
      normalizedPresetName &&
      (normalizedSourceId.includes(normalizedPresetName) ||
        normalizedSourceName.includes(normalizedPresetName))
    ) {
      score += 50;
    }

    if (
      normalizedPresetId &&
      (normalizedSourceId.includes(normalizedPresetId) ||
        normalizedSourceName.includes(normalizedPresetId))
    ) {
      score += 25;
    }

    if (presetTokens.length > 0) {
      const matchedTokens = presetTokens.filter((token) => sourceTokens.has(token));
      if (matchedTokens.length === presetTokens.length) score += 25;
      score += matchedTokens.reduce((total, token) => total + Math.min(token.length, 8), 0);
    }

    if (score > (bestMatch?.score ?? 0)) {
      bestMatch = { icon: preset.icon, score };
    }
  }

  return (bestMatch?.score ?? 0) >= 20 ? bestMatch!.icon : null;
};

export function ConnectedSourceIcon(props: {
  readonly source: ConnectedSourceLike;
  readonly plugin?: SourcePlugin;
  readonly size?: number;
}) {
  const { source, plugin, size = 16 } = props;
  const presetIcon = findPresetIcon(source, plugin);

  if (presetIcon) {
    return (
      <img
        src={presetIcon}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        className="shrink-0 object-contain"
        style={{ width: size, height: size }}
      />
    );
  }

  return <SourceFavicon url={source.url} size={size} />;
}
