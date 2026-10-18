// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Types for C64 READY. user port devices, API version 1.
// See https://c64ready.com/docs/userport-devices.html

/** TTL level at a pin: 1 is high, 0 is low. */
export type Level = 0 | 1;

export interface DeviceMeta {
  /** Lowercase letters, digits, dots and dashes. `builtin.` is reserved. */
  id: string;
  name: string;
  version: string;
  apiVersion: 1;
  author?: string;
  description?: string;
}

/** The connector, in emulated time. */
export interface UserPort {
  readonly apiVersion: 1;
  /** 985248, the PAL clock. */
  readonly cyclesPerSecond: number;
  /** The current machine cycle. */
  now(): number;
  /** Drive the PB lines in `mask` to `levels`, release the others. */
  drivePB(mask: number, levels: number): void;
  /** Drive FLAG2. A falling edge sets CIA2 ICR bit 4. */
  setFlag(level: Level): void;
  /** Call `onTimer` at `cycle`. One timer, a new call replaces it. */
  wakeAt(cycle: number): void;
  cancelWake(): void;
  /** PB0-PB7 as the C64 drives them (inputs read high). */
  c64PB(): number;
  /** PA2 as the C64 drives it. */
  c64PA2(): Level;
}

export interface Socket {
  send(bytes: Uint8Array | number[]): void;
  close(): void;
  onopen: (() => void) | null;
  ondata: ((bytes: Uint8Array) => void) | null;
  onclose: ((reason: string) => void) | null;
}

/** The app around the device, in real time. */
export interface Host {
  /** The device's panel in the User Port card. `null` in the CLI. */
  readonly panel: ShadowRoot | null;
  css(text: string): CSSStyleSheet | null;
  /** Called once per displayed frame: the place to update the page. */
  onFrame(fn: () => void): void;
  status(text: string): void;
  readonly storage: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  };
  /** A TCP connection through the relay. Host `echo` loops back. */
  openSocket(host: string, port: number): Socket;
  log(...args: unknown[]): void;
}

/** Everything is optional. Port callbacks run inside an emulated cycle. */
export interface Device {
  onPortB?(levels: number): void;
  onPA2?(level: Level): void;
  onPC2?(): void;
  onTimer?(cycle: number): void;
  reset?(): void;
  detach?(): void;
  serialize?(): unknown;
  deserialize?(state: any): void;
}

export declare const meta: DeviceMeta;
export declare function create(port: UserPort, host: Host | null): Device;
