<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# reSID measured combined-waveform sample data

The eight `wave*.dat` files are reSID's OSC3 samplings of real 6581/8580
combined waveforms (4096 × 8-bit samples each), taken from the `src/resid`
tree of the official VICE 3.10 source release (upstream pin — tarball name,
sha256 and URL — in the repository's NOTICE.txt). Copyright (C) 2010
Dag Lem, GNU GPL version 2 or (at your option) any later version. Sample
lineage: chip samplings provided to reSID by Tibor Biczo, Andreas Boose and
André Fachat (reSID THANKS). The same data ships in src/sid-wavetables.js
for the JavaScript engines; this copy feeds `include_bytes!` for the WASM
engine.
