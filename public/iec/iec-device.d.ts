// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import type { Host } from '../userport/userport-device.js';
export interface IecMeta {
  id: string; name: string; version: string; bus: 'iec'; apiVersion: 1;
  /** Default address, 4 to 30, excluding drive slots 8 and 9. */
  address?: number;
  author?: string;
  description?: string;
}
export interface IecDevice {
  onLines?(levels: number): void;
  onTimer?(cycle: number): void;
  reset?(): void;
  detach?(): void;
  serialize?(): unknown;
  deserialize?(state: any): void;
}
export interface IecListener extends IecDevice { resume(): void; }
export interface IecPort {
  readonly apiVersion: 1;
  readonly address: number;
  readonly cyclesPerSecond: number;
  now(): number;
  /** Physical TTL, DATA=1, CLK=2, ATN=4. A zero bit is asserted. */
  lines(): number;
  /** Drive DATA/CLK bits in mask, release other bits. ATN belongs to the C64. */
  drive(mask: number, levels: number): void;
  wakeAt(cycle: number): void;
  cancelWake(): void;
  createListener(callbacks: {
    onByte?(byte: number, channel: number, eoi: boolean, kind: 'open'|'close'|'data'): boolean | void;
    onListen?(channel: number): void;
    onOpen?(channel: number): void;
    onClose?(channel: number): void;
    onUnlisten?(): void;
    onCommand?(byte: number): void;
  }): IecListener;
}
export declare const meta: IecMeta;
export declare function create(port: IecPort, host: Host | null): IecDevice;
