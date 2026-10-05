// Pagar aturan 9 dan 2: parsers/ adalah fungsi murni. Tidak mengimpor Prisma atau modul mana pun,
// tidak membaca jam sistem, tidak mengakses jaringan, dan tidak punya jalur bagi LLM menyentuh
// nominal atau tanggal. Memeriksa SUMBERNYA, jadi menangkap pelanggaran yang tidak terlihat di
// test perilaku. Gagal selama src/parsers/ belum lengkap (P14); hanya types.ts yang ada di P13.
//
// Boleh: berkas saudara ("./x.js") dan `../shared/**` yang murni (timezone.ts menyatakan semua
// hitungan Asia/Jakarta harus lewat berkas itu, jadi date.ts wajib memakainya). Selain itu tidak.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PARSERS_DIR = join(process.cwd(), 'src', 'parsers');

const REQUIRED_FILES = ['index', 'normalize', 'intent', 'amount', 'date', 'category', 'validate', 'keywords', 'types'];

/** Berkas sumber tanpa komentar, supaya kata di komentar tidak dianggap pelanggaran. */
function sources(): Array<{ file: string; code: string }> {
  // Hanya types.ts yang ada di P13. Memeriksa sebagian berkas akan lolos begitu saja dan
  // menyembunyikan fakta bahwa parsernya belum ada, jadi semua berkas wajib lebih dulu.
  const missing = REQUIRED_FILES.filter((name) => !existsSync(join(PARSERS_DIR, `${name}.ts`)));
  if (missing.length > 0) {
    throw new Error(`Parser belum diimplementasikan: src/parsers/ belum lengkap (kurang: ${missing.join(', ')}; tugas P14)`);
  }
  return readdirSync(PARSERS_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((file) => ({
      file,
      code: readFileSync(join(PARSERS_DIR, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1'),
    }));
}

function specifiers(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]([^'"]+)['"]/g)) {
    found.push(match[1] as string);
  }
  return found;
}

describe('parsers/: struktur (BACKEND-STRUCTURE.md Bagian 6)', () => {
  it.each(REQUIRED_FILES)('src/parsers/%s.ts ada', (name) => {
    expect(existsSync(join(PARSERS_DIR, `${name}.ts`)), `src/parsers/${name}.ts`).toBe(true);
  });
});

describe('parsers/: aturan 9, fungsi murni tanpa modul lain', () => {
  it('hanya mengimpor berkas saudara atau ../shared/', () => {
    const violations: string[] = [];
    for (const { file, code } of sources()) {
      for (const spec of specifiers(code)) {
        const sibling = /^\.\/[\w-]+\.js$/.test(spec);
        const shared = /^\.\.\/shared\/[\w/-]+\.js$/.test(spec);
        if (!sibling && !shared) violations.push(`${file}: ${spec}`);
      }
    }
    expect(violations, 'impor terlarang di parsers/').toEqual([]);
  });

  it.each([
    ['@prisma/client', /@prisma\/client/],
    ['modules/', /modules\//],
    ['gateways/', /gateways\//],
    ['lib/ (database, auth, redis)', /\.\.\/lib\//],
    ['config/ (env, logger, redis)', /\.\.\/config\//],
    ['queues/ atau workers/', /\.\.\/(queues|workers)\//],
    ['express', /from\s+['"]express['"]/],
  ])('tidak menyebut %s', (_name, pattern) => {
    for (const { file, code } of sources()) {
      expect(code, file).not.toMatch(pattern);
    }
  });
});

describe('parsers/: murni dan deterministik', () => {
  it.each([
    ['Date.now()', /Date\.now\s*\(/],
    ['new Date() tanpa argumen (jam sistem)', /new\s+Date\s*\(\s*\)/],
    ['Math.random()', /Math\.random\s*\(/],
    ['fetch / jaringan', /\bfetch\s*\(|node:https?|node:net|node:dns/],
    ['berkas dan proses (node:fs, node:child_process, process.env)', /node:fs|node:child_process|process\.env/],
    ['setTimeout / setInterval (efek samping waktu)', /\bset(Timeout|Interval)\s*\(/],
    ['console.log (efek samping)', /console\.\w+\s*\(/],
  ])('tidak memakai %s', (_name, pattern) => {
    for (const { file, code } of sources()) {
      expect(code, file).not.toMatch(pattern);
    }
  });
});

describe('parsers/: aturan 2, LLM tidak pernah menentukan nominal atau tanggal', () => {
  it('tidak mengimpor LLM apa pun; amount.ts dan date.ts murni regex', () => {
    for (const { file, code } of sources()) {
      expect(code, file).not.toMatch(/\bllm/i);
    }
  });

  it('types.ts tidak mengimpor apa pun', () => {
    const types = sources().find(({ file }) => file === 'types.ts');
    expect(types, 'src/parsers/types.ts').toBeDefined();
    expect(specifiers(types?.code ?? '')).toEqual([]);
  });
});
