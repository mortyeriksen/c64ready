// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// native/rcheevos/c64_cheevos.c — the app's door into rcheevos (vendored in
// ./rcheevos, MIT): its runtime evaluates achievement and leaderboard
// conditions once per emulated frame, and its hasher names the loaded file.
//
// rcheevos's Commodore 64 memory map (consoleinfo.c) is a flat 64 KB that
// always reads RAM, ROM and I/O banking aside. The app copies the C64's RAM
// into `ram` before each frame, so the memory reads below never leave
// WebAssembly. Events from a frame are kept here and read back by index.

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "rc_runtime.h"
#include "rc_runtime_types.h"
#include "rc_version.h"
#include "rc_hash.h"
#include "rc_consoles.h"
#include "rc_error.h"

#define EXPORT(name) __attribute__((export_name(name)))
#define MAX_EVENTS 256

static uint8_t ram[0x10000];
static rc_runtime_t runtime;
static int runtime_ready;

typedef struct { uint32_t type; uint32_t id; int32_t value; } event_t;
static event_t events[MAX_EVENTS];
static uint32_t event_count;
static uint32_t events_dropped;

/* Little-endian reads of 1 to 4 bytes; addresses past 64 KB read 0. */
static uint32_t peek(uint32_t address, uint32_t num_bytes, void* ud) {
  (void)ud;
  uint32_t value = 0;
  for (uint32_t i = 0; i < num_bytes && i < 4; i++) {
    uint32_t a = address + i;
    if (a > 0xFFFF) break;
    value |= (uint32_t)ram[a] << (8 * i);
  }
  return value;
}

static void on_event(const rc_runtime_event_t* e) {
  if (event_count >= MAX_EVENTS) { events_dropped++; return; }
  events[event_count].type = e->type;
  events[event_count].id = e->id;
  events[event_count].value = e->value;
  event_count++;
}

static void ensure_runtime(void) {
  if (!runtime_ready) { rc_runtime_init(&runtime); runtime_ready = 1; }
}

EXPORT("cc_ram") uint8_t* cc_ram(void) { return ram; }
EXPORT("cc_alloc") void* cc_alloc(uint32_t size) { return malloc(size ? size : 1); }
EXPORT("cc_free") void cc_free(void* p) { free(p); }

/* Drops every achievement and leaderboard: a new game, or none. */
EXPORT("cc_clear") void cc_clear(void) {
  if (runtime_ready) rc_runtime_destroy(&runtime);
  rc_runtime_init(&runtime);
  runtime_ready = 1;
  event_count = 0;
}

/* Back to waiting: every achievement must see its conditions false again (a reset machine). */
EXPORT("cc_reset") void cc_reset(void) { ensure_runtime(); rc_runtime_reset(&runtime); }

/* 0 on success, else an RC_ error code (rc_error.h). */
EXPORT("cc_activate_achievement") int cc_activate_achievement(uint32_t id, const char* memaddr) {
  ensure_runtime();
  return rc_runtime_activate_achievement(&runtime, id, memaddr, NULL, 0);
}
EXPORT("cc_deactivate_achievement") void cc_deactivate_achievement(uint32_t id) {
  ensure_runtime();
  rc_runtime_deactivate_achievement(&runtime, id);
}
EXPORT("cc_activate_lboard") int cc_activate_lboard(uint32_t id, const char* memaddr) {
  ensure_runtime();
  return rc_runtime_activate_lboard(&runtime, id, memaddr, NULL, 0);
}
EXPORT("cc_deactivate_lboard") void cc_deactivate_lboard(uint32_t id) {
  ensure_runtime();
  rc_runtime_deactivate_lboard(&runtime, id);
}

/* One frame: evaluates everything against `ram`; returns how many events it raised. */
EXPORT("cc_do_frame") uint32_t cc_do_frame(void) {
  ensure_runtime();
  event_count = 0;
  rc_runtime_do_frame(&runtime, on_event, peek, NULL, NULL);
  return event_count;
}
EXPORT("cc_event_type") uint32_t cc_event_type(uint32_t i) { return i < event_count ? events[i].type : 0; }
EXPORT("cc_event_id") uint32_t cc_event_id(uint32_t i) { return i < event_count ? events[i].id : 0; }
EXPORT("cc_event_value") int32_t cc_event_value(uint32_t i) { return i < event_count ? events[i].value : 0; }
EXPORT("cc_events_dropped") uint32_t cc_events_dropped(void) { return events_dropped; }

/* The rcheevos hash of a C64 file (32 hex digits into out[33]); 1 on success. */
EXPORT("cc_hash") int cc_hash(const uint8_t* buffer, uint32_t size, char* out) {
  return rc_hash_generate_from_buffer(out, RC_CONSOLE_COMMODORE_64, buffer, size);
}

/* A leaderboard value as text in its format (RC_FORMAT_*): the length written. */
EXPORT("cc_format_value") int cc_format_value(char* out, int size, int32_t value, int format) {
  return rc_format_value(out, size, value, format);
}
/* The RC_FORMAT_ code for a format name such as "SCORE" or "TIME". */
EXPORT("cc_parse_format") int cc_parse_format(const char* name) { return rc_parse_format(name); }

/* The rcheevos version, as major * 1000000 + minor * 1000 + patch. */
EXPORT("cc_version") uint32_t cc_version(void) { return RCHEEVOS_VERSION; }
