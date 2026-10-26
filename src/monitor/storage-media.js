// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// Abstract media silhouettes use theme colours. Tape reel proportions reflect
// the sampled position, while chip and contact counts are illustrative.
export function drawStorageMedia(ctx, selected, state, { ink, accent, dim, bg }) {
  ctx.clearRect(0,0,480,300);ctx.fillStyle=bg;ctx.fillRect(0,0,480,300);
  function shape(points,opacity=.09) {
    ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();
    ctx.fillStyle=ink;ctx.globalAlpha=opacity;ctx.fill();ctx.globalAlpha=1;ctx.strokeStyle=dim;ctx.lineWidth=2;ctx.stroke();
  }
  function rect(x,y,w,h,opacity=.09) {shape([[x,y],[x+w,y],[x+w,y+h],[x,y+h]],opacity);}
  function line(x,y,ex,ey,colour=dim,width=2) {ctx.strokeStyle=colour;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(ex,ey);ctx.stroke();}
  function label(value,x,y,size=15,colour=ink) {ctx.fillStyle=colour;ctx.font=`${size}px monospace`;ctx.textAlign='center';ctx.fillText(value,x,y);}
  function circle(x,y,r,colour=dim,width=2) {ctx.strokeStyle=colour;ctx.lineWidth=width;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.stroke();}
  function hole(x,y,w,h) {ctx.fillStyle=bg;ctx.fillRect(x,y,w,h);ctx.strokeStyle=dim;ctx.lineWidth=2;ctx.strokeRect(x,y,w,h);}
  function rounded(x,y,w,h,r,opacity=.1) {
    ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fillStyle=ink;ctx.globalAlpha=opacity;ctx.fill();ctx.globalAlpha=1;ctx.strokeStyle=dim;ctx.lineWidth=2;ctx.stroke();
  }
  function connector(y) {
    rect(167,y,146,32,.13);
    for(let i=0;i<22;i++){ctx.fillStyle=accent;ctx.globalAlpha=.7;ctx.fillRect(173+i*6.1,y+9,3.5,23);}
    ctx.globalAlpha=1;
  }
  function screw(x,y) {circle(x,y,3,dim,1);line(x-2,y,x+2,y,dim,1);}
  if(selected<2) {
    // A 5¼-inch disk jacket with an index hole and radial head opening.
    shape([[119,25],[350,25],[363,38],[363,101],[353,101],[353,121],[363,121],[363,269],[119,269]],.16);
    line(124,263,357,263,dim,1);line(124,31,124,260,dim,1);
    rounded(143,39,195,56,2,.3);
    label('SIDE A',173,58,10,accent);label('5¼',317,59,11,ink);
    line(157,68,324,68,dim,1);line(157,82,291,82,dim,1);
    ctx.fillStyle=bg;ctx.beginPath();ctx.arc(240,150,41,0,Math.PI*2);ctx.fill();
    circle(240,150,41,dim,2);circle(240,150,31,dim,1);circle(240,150,14,accent,3);
    circle(240,150,18,dim,1);circle(291,187,4,accent,2);
    ctx.beginPath();ctx.roundRect(225,204,30,48,13);ctx.fillStyle=bg;ctx.fill();ctx.strokeStyle=dim;ctx.lineWidth=2;ctx.stroke();
    line(233,213,233,243,dim,1);line(247,213,247,243,dim,1);
  } else if(selected===2) {
    const fraction=Math.max(0,Math.min(1,state.tape.fraction||0));
    // The shell follows the compact cassette's 100.4 × 63.8 mm face ratio.
    shape([[66,29],[414,29],[428,43],[428,268],[52,268],[52,43]],.14);
    line(58,262,422,262,dim,1);
    rounded(73,51,334,160,8,.13);
    label('SIDE A',110,74,10,accent);label('COMPACT CASSETTE',240,74,10,ink);label('C60',378,74,13,accent);
    line(86,86,393,86,dim,1);line(86,99,393,99,dim,1);
    ctx.beginPath();ctx.roundRect(112,122,256,73,36);ctx.fillStyle=bg;ctx.fill();ctx.strokeStyle=dim;ctx.lineWidth=2;ctx.stroke();
    for(const [x,r] of [[160,14+14*(1-fraction)],[320,14+14*fraction]]) {
      circle(x,158,30,dim,1);circle(x,158,r,dim,6);circle(x,158,12,accent,2);
      for(let n=0;n<6;n++){const a=n*Math.PI/3;line(x+Math.cos(a)*7,158+Math.sin(a)*7,x+Math.cos(a)*13,158+Math.sin(a)*13,ink,2);}
    }
    hole(204,143,72,30);line(210,158,270,158,dim,2);
    shape([[137,268],[151,230],[329,230],[343,268]],.08);
    circle(169,250,5);circle(311,250,5);circle(194,252,3);circle(286,252,3);hole(220,254,40,9);
    for(const [x,y] of [[65,43],[415,43],[65,254],[415,254]])screw(x,y);
    for(let i=0;i<5;i++){line(81,233+i*4,125,233+i*4,dim,1);line(355,233+i*4,399,233+i*4,dim,1);}
  } else if(selected===3) {
    shape([[139,37],[341,37],[353,49],[353,234],[313,234],[313,265],[167,265],[167,234],[127,234],[127,49]],.1);
    rect(150,61,180,55,.15);label('ROM',240,99,30,accent);
    rect(178,143,124,58,.08);
    for(let i=0;i<7;i++){line(189+i*17,135,189+i*17,143,dim,3);line(189+i*17,201,189+i*17,209,dim,3);}
    connector(234);
    label(state.cartridge.inserted?`BANK ${state.cartridge.bank}`:'CARTRIDGE',240,178,14,ink);
  } else {
    // Offset memory planes represent expansion capacity, not a physical bank count.
    rect(98,39,296,176,.04);rect(86,51,296,176,.06);rect(74,63,296,176,.1);
    for(let y=0;y<4;y++)for(let x=0;x<8;x++)rect(95+x*32,85+y*27,23,18,(x+y)%3===0?.2:.07);
    line(95,204,348,204,dim,1);label('RAM',130,226,18,accent);
    const reu=state.reu;label(reu.attached?`${reu.bytes/1024} KB`:'EXPANSION',290,225,14,ink);
    connector(239);
    label('REU',240,282,12,dim);
  }
  ctx.globalAlpha=1;
}
