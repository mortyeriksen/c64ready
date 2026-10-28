// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

const rule=(id,section,title,requires,explanation)=>({id,section,title,requires,explanation});
export const OBSERVATION_RULES=[
  rule('memory.vic-map','2.4.2','Select RAM or character ROM','actual memory route, local address and VIC bank','The VIC addresses one 16 KB bank. Character ROM appears at physical $1000–$1FFF and $9000–$9FFF. Ultimax cartridge mapping is outside this Bauer memory-map check.'),
  rule('memory.colour-bus','2.4.1 / 4','Read four colour bits','colour RAM byte, external bus and returned CPU byte','Colour RAM supplies the low four bits. The high four bits retain the shared bus value.'),
  rule('memory.port-underlay','4','Write beneath the processor port','port write, retained bus byte, port latch and underlying RAM','Writing $00 or $01 updates the internal processor port. Underlying RAM receives the retained external bus byte, which need not equal the CPU write value.'),
  rule('register.readback','3.2','Read connected register bits','returned register byte and stored inputs','Unconnected bits read as one. IRQ reads combine pending sources with their master flag. Collision clearing is checked separately.'),
  rule('register.raster-read','3.2','Read the current raster','returned byte and CPU-visible raster counter','Reading $D012 returns the low eight raster bits. Reading $D011 combines raster bit eight with its seven control bits, not the programmed interrupt target.'),
  rule('register.read-only','3.2','Ignore writes to read-only registers','write value and register before and after','Collision registers and unconnected registers do not latch CPU writes. A write still drives the internal bus.'),
  rule('irq.collision-first','3.12','Interrupt on the first collision','collision latch and IRQ state before and after','A collision requests its interrupt when the collision register changes from zero to nonzero. Further bits do not request another interrupt until the collision register has been read and cleared.'),
  rule('irq.raster-edge','3.12 / VICE addendum','React to a raster comparison edge','comparison inputs and IRQ latch before and after','A new raster match sets the interrupt source. Writing a matching target can trigger immediately, but a held comparison does not repeatedly trigger. The recorded comparator state distinguishes a fresh match from a held match.'),
  rule('sprite.mc-reload','3.8.1 rule 4','Copy the sprite row base','MCBASE and MC immediately after reload','At cycle 58, MC copies MCBASE before any subsequent sprite data access. This checks the reload without inferring the timing of grouped reads.'),
  rule('sprite.byte-order','3.8.1','Build the sprite shift register','three row bytes and resulting shift register','The first byte supplies the leftmost eight bits, the second the middle eight and the third the rightmost eight.'),
  rule('lightpen.frame-reset','3.11 / VICE addendum','Rearm the lightpen each frame','frame-start input, trigger state and coordinate latches','A new frame rearms the one-shot latch. A held-low input triggers at the beginning of the new frame, including the lightpen interrupt source.'),
  rule('bus.fetch-latch','2.4.3 / 4','Drive the shared data bus','actual VIC read and subsequent bus latches','A real VIC fetch drives its internal data bus and the shared external byte. Renderer-only reads do not qualify as bus accesses.'),
];

export function prepareObservationRules(frame){
  const n=frame.lines*frame.cyclesPerLine,rows=new Map(OBSERVATION_RULES.map(r=>[r.id,new Uint8Array(n)])),e=frame.provenance?.rules;
  if(!e||e.version<2||e.overflow||frame.provenance.overflow||frame.overflow){for(const row of rows.values())row.fill(3);return rows;}
  function check(id,t,correct){const row=rows.get(id);if(t>=n)return;row[t]=row[t]===2||!correct?2:1;}
  for(let i=0;i<e.count;i++){
    const t=e.tick[i],a=e.a[i],b=e.b[i],c=e.c[i],d=e.d[i],f=e.f[i],g=e.g[i];
    switch(e.kind[i]){
      case 10: {
        if(a===0x11||a===0x12){check('register.raster-read',t,b===(a===0x12?d&255:(c&127)|((d&256)>>>1)));break;}
        if(a===0x1e||a===0x1f)break;
        const expected=a>=0x2f?255:a===0x16?c|192:a===0x18?c|1:a===0x19?e.e[i]|112:a===0x1a?f|240:a>=0x20?c|240:c;
        check('register.readback',t,b===expected);break;
      }
      case 11:check('register.read-only',t,b===c);break;
      case 5: {
        const bit=a===0x1e?4:2,before=e.e[i],fire=b===0&&c!==0;
        const expected=(before&15)|(fire?bit:0);
        check('irq.collision-first',t,(g&15)===expected&&!!(g&128)===!!(expected&f&15));break;
      }
      case 12: {
        const matched=!!(f&1),dip=!!(f&2);
        const fire=g===1?a!==b&&a!==c&&b===c&&!matched:b===c&&(!matched||dip);
        check('irq.raster-edge',t,(e.e[i]&15)===((d&15)|(fire?1:0)));break;
      }
      case 13:check('sprite.mc-reload',t,b===c);break;
      case 14: {
        const held=a===0;
        check('lightpen.frame-reset',t,!!b===held&&(!held||(c===(((0x194+f*8)%504)>>>1)&&d===0&&!!(e.e[i]&8))));break;
      }
      case 15:
        check('bus.fetch-latch',t,b===(a&255)&&(c===256||c===(a&255)));
        if(!g){const address=f+e.e[i],rom=(address>=0x1000&&address<0x2000)||(address>=0x9000&&address<0xa000);check('memory.vic-map',t,(f&0x3fff)===0&&f<=0xc000&&d===(rom?1:0));}
        break;
      case 18:check('memory.colour-bus',t,c===((a&15)|(b&240)));break;
      case 19:check('memory.port-underlay',t,d===c&&e.e[i]===b);break;
      case 16:check('sprite.byte-order',t,e.e[i]===((b<<16)|(c<<8)|d));break;
    }
  }
  return rows;
}

export function observedRuleEvidence(frame,id,tick){
  const kinds={'register.readback':10,'register.raster-read':10,'register.read-only':11,'irq.collision-first':5,'irq.raster-edge':12,'sprite.mc-reload':13,'lightpen.frame-reset':14,'bus.fetch-latch':15,'memory.vic-map':15,'sprite.byte-order':16,'memory.colour-bus':18,'memory.port-underlay':19};
  const kind=kinds[id],e=frame.provenance?.rules,lines=[];
  if(kind===undefined||!e||e.version<2)return lines;
  const hex=(value,width=2)=>'$'+value.toString(16).toUpperCase().padStart(width,'0');
  for(let i=0;i<e.count;i++){
    if(e.kind[i]!==kind||e.tick[i]!==tick)continue;
    const a=e.a[i],b=e.b[i],c=e.c[i],d=e.d[i],f=e.f[i],g=e.g[i];
    if(kind===10){if((a===17||a===18)!==(id==='register.raster-read'))continue;lines.push(`${hex(0xd000+a,4)} read ${hex(b)} · stored ${hex(c)} · raster ${d} · IRQ ${hex(e.e[i])} · mask ${hex(f)}`);}
    else if(kind===11)lines.push(`${hex(0xd000+a,4)} written ${hex(d)} · latch ${hex(b)} → ${hex(c)}`);
    else if(kind===5)lines.push(`${hex(0xd000+a,4)} collision bits ${hex(c)} · latch ${hex(b)} → ${hex(d)} · IRQ ${hex(e.e[i])} → ${hex(g)} · mask ${hex(f)}`);
    else if(kind===12)lines.push(`${g?'CPU target write':'Line comparison'} · target ${a} → ${b} · raster ${c} · IRQ ${hex(d)} → ${hex(e.e[i])} · previous match ${f&1?'yes':'no'} · intervening dip ${f&2?'yes':'no'}`);
    else if(kind===13)lines.push(`Sprite ${a} · MCBASE ${b} → MC ${c}`);
    else if(kind===14)lines.push(`Input ${a?'high':'low'} · latched ${b?'yes':'no'} · X ${c} · Y ${d} · IRQ ${hex(e.e[i])}`);
    else if(kind===15)lines.push(id==='memory.vic-map'?`Bank ${hex(f,4)} + local ${hex(e.e[i],4)} · route ${['RAM','character ROM','cartridge ROM'][d]??'unknown'}${g?' · Ultimax':''}`:`Fetched ${hex(a)} · VIC bus ${hex(b)} · external bus ${c===256?'not attached':hex(c)}`);
    else if(kind===16)lines.push(`Sprite ${a} · bytes ${hex(b)} ${hex(c)} ${hex(d)} → shifter ${hex(e.e[i],6)}`);
    else if(kind===18)lines.push(`Colour RAM ${hex(a)} · bus ${hex(b)} → returned ${hex(c)}`);
    else if(kind===19)lines.push(`Port ${a} written ${hex(b)} · bus ${hex(c)} → RAM ${hex(d)} · port latch ${hex(e.e[i])}`);
  }
  return lines;
}
