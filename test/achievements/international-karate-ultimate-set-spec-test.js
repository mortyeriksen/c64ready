// Spec tests for the International Karate Ultimate achievement set
// (server/sets/international-karate-ultimate.json, the 2018 edition on the OneLoad64 extras EasyFlash
// cartridge): the checks in karate-set-spec.js, with the belt names at $2616 and the infinite time
// trainer's NOPs at $0BB1.
import { karateSpec } from './karate-set-spec.js';

await karateSpec({
  id: 'international-karate-ultimate',
  sig: 0x2616,
  assets: [['international-karate-ultimate-crt', '69bc95b4757deb90592c3f29259aeda9']],
  trainer: 0x0bb1,
});
