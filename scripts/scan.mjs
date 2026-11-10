// Repo hygiene scan (docs/v2/BRIEF.md, hard limits 4 and 5). Fails when a
// text file in the repo holds an em dash or en dash, an email address, or a
// term from the local deny list.
//
// The deny list (organisation names and the like) must never be committed, so
// it lives outside the tracked files: one term per line in `.scan-deny.local`
// (ignored by git) or comma separated in the RALLY_SCAN_DENY variable.
//
// Usage: node scripts/scan.mjs           scan every tracked or new file
//        node scripts/scan.mjs --diff    scan only lines added since `main`
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const SKIP = /(^|\/)(package-lock\.json|node_modules\/|dist\/)|\.(csv|png|jpg|jpeg|webp|gif|ico|woff2?|ttf|otf|mp3|ogg|wav|glb|bin)$/i;
const DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/;
/** Things that look like an address and are not one: npm scopes with versions, and CSS or JS at-rules. */
const NOT_EMAIL = /^(@|[\w.-]+@\d)|@(media|import|font-face|keyframes|supports|layer|types|param|returns)\b/;

function denyTerms() {
  const terms = [];
  const file = new URL('.scan-deny.local', root);
  if (existsSync(file)) terms.push(...readFileSync(file, 'utf8').split(/\r?\n/));
  if (process.env.RALLY_SCAN_DENY) terms.push(...process.env.RALLY_SCAN_DENY.split(','));
  return terms.map((t) => t.trim().toLowerCase()).filter((t) => t && !t.startsWith('#'));
}

function check(line, deny) {
  const found = [];
  if (DASH.test(line)) found.push('em or en dash');
  const mail = line.match(EMAIL);
  if (mail && !NOT_EMAIL.test(mail[0])) found.push(`email address (${mail[0].replace(/^[^@]*/, '...')})`);
  const lower = line.toLowerCase();
  for (const term of deny) if (lower.includes(term)) found.push('deny-list term');
  return found;
}

const deny = denyTerms();
const problems = [];

if (process.argv.includes('--diff')) {
  let file = '';
  let lineNo = 0;
  for (const line of git('diff', '--unified=0', '--no-color', 'main', '--', '.').split('\n')) {
    if (line.startsWith('+++ ')) { file = line.slice(6); continue; }
    const hunk = line.match(/^@@ -\S+ \+(\d+)/);
    if (hunk) { lineNo = Number(hunk[1]); continue; }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (!SKIP.test(file)) for (const what of check(line.slice(1), deny)) problems.push(`${file}:${lineNo}: ${what}`);
    lineNo++;
  }
  for (const subject of git('log', '--format=%s%n%b', 'main..HEAD').split('\n')) {
    for (const what of check(subject, deny)) problems.push(`commit message: ${what}`);
  }
} else {
  const files = git('ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter((f) => f && !SKIP.test(f));
  for (const file of files) {
    const path = new URL(file.split('/').map(encodeURIComponent).join('/'), root);
    if (!existsSync(path)) continue;
    readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
      for (const what of check(line, deny)) problems.push(`${file}:${i + 1}: ${what}`);
    });
  }
}

if (problems.length) {
  console.error(`scan: ${problems.length} problem${problems.length > 1 ? 's' : ''}`);
  for (const p of problems.slice(0, 60)) console.error('  ' + p);
  process.exit(1);
}
console.log(`scan: clean (${deny.length} deny-list term${deny.length === 1 ? '' : 's'} loaded)`);
