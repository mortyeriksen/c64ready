// Spec tests for the International Karate achievement set (server/sets/international-karate.json, System 3
// 1986, World Karate Championship in the US, on the OneLoad64 cartridges for tape sides 1 and 2): the
// checks in karate-set-spec.js, with the belt names at $253D.
import { karateSpec } from './karate-set-spec.js';

await karateSpec({
  id: 'international-karate',
  sig: 0x253d,
  assets: [['international-karate-side-1-crt', '62b0003ad31a1c981a49deee6d56bc65'], ['international-karate-side-2-crt', 'e3753c071ed31615d3a647e74da17568']],
});
