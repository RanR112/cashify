// Payload webhook OpenWA v4.76.0 asli dari spike P0, dengan nama, nomor, LID, dan URL disamarkan
// (tests/fixtures/openwa/). Bentuknya sengaja tidak diubah: yang diuji adalah kenyataan, bukan
// dugaan tentang dokumentasi.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type OpenWaFixtureName =
  | 'dm-on-message'
  | 'dm-on-any-message'
  | 'image-on-message'
  | 'bot-reply-on-any-message'
  | 'bot-reply-on-ack'
  | 'group-ciphertext-on-message'
  | 'group-chat-on-message';

/** Longgar: test mengubah beberapa field (id, fromMe) untuk membuat varian. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpenWaEnvelope = { [key: string]: any; data: { [key: string]: any } };

/** Salinan baru tiap panggilan, jadi test boleh mengubahnya. */
export function openwaFixture(name: OpenWaFixtureName): OpenWaEnvelope {
  const path = fileURLToPath(new URL(`../fixtures/openwa/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as OpenWaEnvelope;
}

/** Pesan pribadi baru dengan id unik, untuk test yang butuh banyak pesan berbeda. */
export function dmWithId(id: string): OpenWaEnvelope {
  const envelope = openwaFixture('dm-on-message');
  envelope.data.id = id;
  return envelope;
}
