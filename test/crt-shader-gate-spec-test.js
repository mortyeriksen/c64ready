// Spec test for the software-rasteriser gate on the CRT shader: a CPU WebGL
// (SwiftShader, llvmpipe, ...) is recognised by the driver's own name, an
// unknown name counts as hardware, and a failing query never throws.
import { isSoftwareGl } from '../src/webgl-presenter.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
const gl = (unmasked, renderer = 'x') => ({
  RENDERER: 0x1F01,
  getExtension: (n) => n === 'WEBGL_debug_renderer_info' && unmasked !== undefined ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null,
  getParameter: (p) => p === 0x9246 ? unmasked : renderer,
});

for (const name of ['Google SwiftShader', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))', 'llvmpipe (LLVM 15.0.7, 256 bits)',
  'Mesa softpipe', 'Microsoft Basic Render Driver', 'SwANGLE']) {
  expect(isSoftwareGl(gl(name)), `${name} is a software rasteriser`);
}
for (const name of ['ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', 'NVIDIA GeForce RTX 3060/PCIe/SSE2',
  'Mali-G78', 'Apple GPU', '']) {
  expect(!isSoftwareGl(gl(name)), `${name || '(empty)'} is taken as hardware`);
}
expect(isSoftwareGl(gl(undefined, 'SwiftShader')), 'without the debug extension the plain RENDERER string is used');
expect(!isSoftwareGl({ getExtension() { throw new Error('lost'); }, getParameter() { throw new Error('lost'); } }), 'a failing query means hardware, not a crash');

console.log('crt shader gate spec: PASS');
