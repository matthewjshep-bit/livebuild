/**
 * Fetch the bundled texture sets from Poly Haven, once, into `public/`.
 *
 * `npm run assets:fetch`. Driven by the manifest in `src/lib/model/assets.ts`
 * so the table there is the one source of what is shipped. Every URL is
 * checked with the API before anything is written, and a set that lacks any
 * of its three maps fails the run loudly rather than leaving a hole for the
 * loader to find at runtime. Writes `public/textures/LICENSES.md` last, so a
 * half-finished run has no licence file.
 *
 * Poly Haven's files are CC0. This script is the only thing that ever
 * downloads from them; the app does not.
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { ASSETS, SKY_ASSET, type AssetKey } from "../src/lib/model/assets";

const API = "https://api.polyhaven.com/files";
const ROOT = join(process.cwd(), "public");
const RESOLUTION = "1k";
const force = process.argv.includes("--force");

type Files = Record<string, Record<string, Record<string, { url: string; size: number }>>>;

async function filesFor(source: string): Promise<Files> {
  const res = await fetch(`${API}/${source}`);
  if (!res.ok) throw new Error(`${source}: API ${res.status}`);
  return (await res.json()) as Files;
}

/**
 * Poly Haven's 1K JPEGs are saved at full quality and weigh half a megabyte
 * each, which put the whole set at fifty megabytes. Re-encoded at 1024 on a
 * side and a quality nobody can tell from the original on a wall, they are a
 * third of that. `sharp` is here because Next brought it; the sky is copied
 * as it is, since an HDR is not a JPEG.
 */
const EDGE = 1024;
const QUALITY = 82;

async function download(url: string, to: string, encode: boolean): Promise<number> {
  if (!force && existsSync(to) && statSync(to).size > 0) return statSync(to).size;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!encode) {
    writeFileSync(to, bytes);
    return bytes.length;
  }
  const out = await sharp(bytes).resize(EDGE, EDGE, { fit: "cover" }).jpeg({ quality: QUALITY, mozjpeg: true }).toBuffer();
  writeFileSync(to, out);
  return out.length;
}

async function main() {
  const lines: string[] = [];
  let total = 0;
  let failures = 0;

  for (const [key, asset] of Object.entries(ASSETS) as Array<[AssetKey, (typeof ASSETS)[AssetKey]]>) {
    try {
      const files = await filesFor(asset.source);
      const pick = (slot: string) => files[slot]?.[RESOLUTION]?.jpg?.url;
      const color = pick("Diffuse");
      const normal = pick("nor_gl");
      const orm = pick("arm");
      if (!color || !normal || !orm) {
        failures++;
        console.log(`  MISSING ${key} (${asset.source}): ${[!color && "Diffuse", !normal && "nor_gl", !orm && "arm"].filter(Boolean).join(", ")} - has ${Object.keys(files).join(", ")}`);
        continue;
      }
      const dir = join(ROOT, "textures", key);
      mkdirSync(dir, { recursive: true });
      const sizes = await Promise.all([
        download(color, join(dir, "color.jpg"), true),
        download(normal, join(dir, "normal.jpg"), true),
        download(orm, join(dir, "orm.jpg"), true),
      ]);
      const bytes = sizes.reduce((a, b) => a + b, 0);
      total += bytes;
      lines.push(`- \`${key}\` — [${asset.source}](https://polyhaven.com/a/${asset.source}), ${asset.licence}, ${asset.metresPerTile} m per tile`);
      console.log(`  ok  ${key.padEnd(16)} ${asset.source.padEnd(32)} ${(bytes / 1024).toFixed(0).padStart(5)} KB`);
    } catch (error) {
      failures++;
      console.log(`  FAIL ${key}: ${(error as Error).message}`);
    }
  }

  try {
    const files = await filesFor(SKY_ASSET.source);
    const url = (files as unknown as { hdri: Record<string, { hdr: { url: string } }> }).hdri?.[RESOLUTION]?.hdr?.url;
    if (!url) throw new Error("no 1k hdr");
    mkdirSync(join(ROOT, "sky"), { recursive: true });
    const bytes = await download(url, join(ROOT, "sky", "studio.hdr"), false);
    total += bytes;
    lines.push(`- \`sky/studio.hdr\` — [${SKY_ASSET.source}](https://polyhaven.com/a/${SKY_ASSET.source}), ${SKY_ASSET.licence}`);
    console.log(`  ok  sky              ${SKY_ASSET.source.padEnd(32)} ${(bytes / 1024).toFixed(0).padStart(5)} KB`);
  } catch (error) {
    failures++;
    console.log(`  FAIL sky: ${(error as Error).message}`);
  }

  if (failures === 0) {
    writeFileSync(
      join(ROOT, "textures", "LICENSES.md"),
      [
        "# Bundled textures",
        "",
        "Every set here was scanned and published by [Poly Haven](https://polyhaven.com) under",
        "[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/): public domain, no attribution required.",
        "Fetched by `tools/fetch-assets.ts` from the manifest in `src/lib/model/assets.ts`, at 1K and re-encoded to 1024px JPEG.",
        "None of these is a photograph of any house the app has modelled.",
        "",
        ...lines,
        "",
      ].join("\n"),
    );
  }

  console.log(failures === 0 ? `ASSETS OK - ${lines.length} sets, ${(total / 1024 / 1024).toFixed(1)} MB` : `ASSETS BROKEN - ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.log(`ASSETS BROKEN - ${(error as Error).message}`);
  process.exit(1);
});
