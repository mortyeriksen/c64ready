// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/disasm6502.mjs — a 6502/6510 disassembler over a byte accessor.
//
// Reading a tape loader means reading its code, and the code is in memory
// rather than in a file, so this takes a `read(addr)` and not a buffer. The
// illegal opcodes are here because loaders use them.

const OPS = {
0x00:['BRK','imp'],0x01:['ORA','izx'],0x05:['ORA','zp'],0x06:['ASL','zp'],0x08:['PHP','imp'],0x09:['ORA','imm'],0x0a:['ASL','acc'],0x0d:['ORA','abs'],0x0e:['ASL','abs'],
0x10:['BPL','rel'],0x11:['ORA','izy'],0x15:['ORA','zpx'],0x16:['ASL','zpx'],0x18:['CLC','imp'],0x19:['ORA','aby'],0x1d:['ORA','abx'],0x1e:['ASL','abx'],
0x20:['JSR','abs'],0x21:['AND','izx'],0x24:['BIT','zp'],0x25:['AND','zp'],0x26:['ROL','zp'],0x28:['PLP','imp'],0x29:['AND','imm'],0x2a:['ROL','acc'],0x2c:['BIT','abs'],0x2d:['AND','abs'],0x2e:['ROL','abs'],
0x30:['BMI','rel'],0x31:['AND','izy'],0x35:['AND','zpx'],0x36:['ROL','zpx'],0x38:['SEC','imp'],0x39:['AND','aby'],0x3d:['AND','abx'],0x3e:['ROL','abx'],
0x40:['RTI','imp'],0x41:['EOR','izx'],0x45:['EOR','zp'],0x46:['LSR','zp'],0x48:['PHA','imp'],0x49:['EOR','imm'],0x4a:['LSR','acc'],0x4c:['JMP','abs'],0x4d:['EOR','abs'],0x4e:['LSR','abs'],
0x50:['BVC','rel'],0x51:['EOR','izy'],0x55:['EOR','zpx'],0x56:['LSR','zpx'],0x58:['CLI','imp'],0x59:['EOR','aby'],0x5d:['EOR','abx'],0x5e:['LSR','abx'],
0x60:['RTS','imp'],0x61:['ADC','izx'],0x65:['ADC','zp'],0x66:['ROR','zp'],0x68:['PLA','imp'],0x69:['ADC','imm'],0x6a:['ROR','acc'],0x6c:['JMP','ind'],0x6d:['ADC','abs'],0x6e:['ROR','abs'],
0x70:['BVS','rel'],0x71:['ADC','izy'],0x75:['ADC','zpx'],0x76:['ROR','zpx'],0x78:['SEI','imp'],0x79:['ADC','aby'],0x7d:['ADC','abx'],0x7e:['ROR','abx'],
0x81:['STA','izx'],0x84:['STY','zp'],0x85:['STA','zp'],0x86:['STX','zp'],0x88:['DEY','imp'],0x8a:['TXA','imp'],0x8c:['STY','abs'],0x8d:['STA','abs'],0x8e:['STX','abs'],
0x90:['BCC','rel'],0x91:['STA','izy'],0x94:['STY','zpx'],0x95:['STA','zpx'],0x96:['STX','zpy'],0x98:['TYA','imp'],0x99:['STA','aby'],0x9a:['TXS','imp'],0x9d:['STA','abx'],
0xa0:['LDY','imm'],0xa1:['LDA','izx'],0xa2:['LDX','imm'],0xa4:['LDY','zp'],0xa5:['LDA','zp'],0xa6:['LDX','zp'],0xa8:['TAY','imp'],0xa9:['LDA','imm'],0xaa:['TAX','imp'],0xac:['LDY','abs'],0xad:['LDA','abs'],0xae:['LDX','abs'],
0xb0:['BCS','rel'],0xb1:['LDA','izy'],0xb4:['LDY','zpx'],0xb5:['LDA','zpx'],0xb6:['LDX','zpy'],0xb8:['CLV','imp'],0xb9:['LDA','aby'],0xba:['TSX','imp'],0xbc:['LDY','abx'],0xbd:['LDA','abx'],0xbe:['LDX','aby'],
0xc0:['CPY','imm'],0xc1:['CMP','izx'],0xc4:['CPY','zp'],0xc5:['CMP','zp'],0xc6:['DEC','zp'],0xc8:['INY','imp'],0xc9:['CMP','imm'],0xca:['DEX','imp'],0xcc:['CPY','abs'],0xcd:['CMP','abs'],0xce:['DEC','abs'],
0xd0:['BNE','rel'],0xd1:['CMP','izy'],0xd5:['CMP','zpx'],0xd6:['DEC','zpx'],0xd8:['CLD','imp'],0xd9:['CMP','aby'],0xdd:['CMP','abx'],0xde:['DEC','abx'],
0xe0:['CPX','imm'],0xe1:['SBC','izx'],0xe4:['CPX','zp'],0xe5:['SBC','zp'],0xe6:['INC','zp'],0xe8:['INX','imp'],0xe9:['SBC','imm'],0xea:['NOP','imp'],0xec:['CPX','abs'],0xed:['SBC','abs'],0xee:['INC','abs'],
0xf0:['BEQ','rel'],0xf1:['SBC','izy'],0xf5:['SBC','zpx'],0xf6:['INC','zpx'],0xf8:['SED','imp'],0xf9:['SBC','aby'],0xfd:['SBC','abx'],0xfe:['INC','abx'],
// common illegals
0x4b:['ALR','imm'],0x6b:['ARR','imm'],0x8b:['ANE','imm'],0xab:['LXA','imm'],0xcb:['SBX','imm'],0x0b:['ANC','imm'],0x2b:['ANC','imm'],
0xa3:['LAX','izx'],0xa7:['LAX','zp'],0xaf:['LAX','abs'],0xb3:['LAX','izy'],0xb7:['LAX','zpy'],0xbf:['LAX','aby'],
0x83:['SAX','izx'],0x87:['SAX','zp'],0x8f:['SAX','abs'],0x97:['SAX','zpy'],
0xc3:['DCP','izx'],0xc7:['DCP','zp'],0xcf:['DCP','abs'],0xd3:['DCP','izy'],0xd7:['DCP','zpx'],0xdb:['DCP','aby'],0xdf:['DCP','abx'],
0xe3:['ISC','izx'],0xe7:['ISC','zp'],0xef:['ISC','abs'],0xf3:['ISC','izy'],0xf7:['ISC','zpx'],0xfb:['ISC','aby'],0xff:['ISC','abx'],
0x03:['SLO','izx'],0x07:['SLO','zp'],0x0f:['SLO','abs'],0x13:['SLO','izy'],0x17:['SLO','zpx'],0x1b:['SLO','aby'],0x1f:['SLO','abx'],
0x23:['RLA','izx'],0x27:['RLA','zp'],0x2f:['RLA','abs'],0x33:['RLA','izy'],0x37:['RLA','zpx'],0x3b:['RLA','aby'],0x3f:['RLA','abx'],
0x43:['SRE','izx'],0x47:['SRE','zp'],0x4f:['SRE','abs'],0x53:['SRE','izy'],0x57:['SRE','zpx'],0x5b:['SRE','aby'],0x5f:['SRE','abx'],
0x63:['RRA','izx'],0x67:['RRA','zp'],0x6f:['RRA','abs'],0x73:['RRA','izy'],0x77:['RRA','zpx'],0x7b:['RRA','aby'],0x7f:['RRA','abx'],
0x9e:['SHX','aby'],0x9c:['SHY','abx'],0x9b:['TAS','aby'],0x93:['SHA','izy'],0x9f:['SHA','aby'],
0x1a:['NOP','imp'],0x3a:['NOP','imp'],0x5a:['NOP','imp'],0x7a:['NOP','imp'],0xda:['NOP','imp'],0xfa:['NOP','imp'],
0x80:['NOP','imm'],0x82:['NOP','imm'],0x89:['NOP','imm'],0xc2:['NOP','imm'],0xe2:['NOP','imm'],
0x04:['NOP','zp'],0x44:['NOP','zp'],0x64:['NOP','zp'],0x14:['NOP','zpx'],0x34:['NOP','zpx'],0x54:['NOP','zpx'],0x74:['NOP','zpx'],0xd4:['NOP','zpx'],0xf4:['NOP','zpx'],
0x0c:['NOP','abs'],0x1c:['NOP','abx'],0x3c:['NOP','abx'],0x5c:['NOP','abx'],0x7c:['NOP','abx'],0xdc:['NOP','abx'],0xfc:['NOP','abx'],
};
const SZ={imp:1,acc:1,imm:2,zp:2,zpx:2,zpy:2,izx:2,izy:2,rel:2,abs:3,abx:3,aby:3,ind:3};
const hx=(n,w=2)=>n.toString(16).padStart(w,'0');

export function disasm(read, addr, count) {
  let out=[]; let p=addr;
  for (let k=0;k<count;k++){
    const op=read(p); const e=OPS[op];
    if(!e){ out.push(`$${hx(p,4)}: ${hx(op)}        .byte $${hx(op)}`); p=(p+1)&0xffff; continue; }
    const [mn,mo]=e; const sz=SZ[mo]; let arg=''; let bytes=hx(op);
    if(sz>=2) bytes+=' '+hx(read((p+1)&0xffff));
    if(sz>=3) bytes+=' '+hx(read((p+2)&0xffff));
    bytes=bytes.padEnd(8,' ');
    if(mo==='imm')arg='#$'+hx(read(p+1));
    else if(mo==='zp')arg='$'+hx(read(p+1));
    else if(mo==='zpx')arg='$'+hx(read(p+1))+',X';
    else if(mo==='zpy')arg='$'+hx(read(p+1))+',Y';
    else if(mo==='abs'){const ad=read(p+1)|(read(p+2)<<8);arg='$'+hx(ad,4);}
    else if(mo==='abx'){const ad=read(p+1)|(read(p+2)<<8);arg='$'+hx(ad,4)+',X';}
    else if(mo==='aby'){const ad=read(p+1)|(read(p+2)<<8);arg='$'+hx(ad,4)+',Y';}
    else if(mo==='ind'){const ad=read(p+1)|(read(p+2)<<8);arg='($'+hx(ad,4)+')';}
    else if(mo==='izx')arg='($'+hx(read(p+1))+',X)';
    else if(mo==='izy')arg='($'+hx(read(p+1))+'),Y';
    else if(mo==='rel'){const off=read(p+1);const tgt=(p+2+(off<128?off:off-256))&0xffff;arg='$'+hx(tgt,4);}
    out.push(`$${hx(p,4)}: ${bytes} ${mn} ${arg}`);
    p=(p+sz)&0xffff;
  }
  return out.join('\n');
}
