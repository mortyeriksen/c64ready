import fs from 'fs';

const input = fs.readFileSync(new URL('../src/input.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/styles-ports.css', import.meta.url), 'utf8');

let failures = 0;
function expect(cond, msg) {
  if (!cond) {
    failures++;
    console.log(`FAIL - ${msg}`);
  }
}

expect(
  input.includes("el.classList.toggle('cp-row-detail-joykeys', isKbdJoy(dev));") &&
    /\.cp-row-detail-joykeys\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*row-gap:\s*4px;/s.test(css) &&
    /\.cp-row-detail-joykeys \.cp-joy-keys\s*\{[^}]*display:\s*contents;/s.test(css),
  'Key-joystick chips retain vertical spacing when they wrap onto another row'
);

expect(
  /\.cp-joy-keys \.kbd\.cp-joy-dir\s*\{[^}]*box-sizing:\s*border-box;[^}]*min-width:\s*24px;[^}]*text-align:\s*center;/s.test(css) &&
    !input.includes('cp-joy-arrow-only'),
  'Every key-joystick chip uses the widened arrow size as its minimum width'
);

if (failures) {
  console.log(`\n${failures} key-joystick wrap spec failure(s)`);
  process.exit(1);
}

console.log('ok  - Key-joystick chip rows have vertical wrap spacing');
