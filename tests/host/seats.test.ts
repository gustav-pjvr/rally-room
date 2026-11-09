import { describe, expect, it } from 'vitest';
import {
  createSeats, expiredSlots, missingPlayers, phoneJoined, seatIn, seatOut, seatReady, seatSlots, takeOverWithKeyboard,
  waitingText, type Phone,
} from '../../src/host/phones';

const phone = (slot: number, seq: number, extra: Partial<Phone> = {}): Phone =>
  ({ slot, name: `P${slot}`, color: null, connected: true, seq, id: `id${slot}`, ...extra });

function twoSeats() {
  const phones = new Map([[1, phone(1, 1, { name: 'Alice' })], [3, phone(3, 2, { name: 'Bob' })]]);
  return createSeats({ humans: 2, slots: [1, 3] }, phones);
}

describe('match players bound to phone ids', () => {
  it('binds each human player to the id of the phone in its slot, keyboard players to null', () => {
    const phones = new Map([[2, phone(2, 1, { name: 'Alice', id: 'pa' })]]);
    const seats = createSeats({ humans: 2, slots: [2, null] }, phones);
    expect(seats).toEqual([
      { id: 'pa', name: 'Alice', slot: 2, ready: true, keyboard: false },
      { id: null, name: 'Player 2', slot: null, ready: true, keyboard: true },
    ]);
    expect(seatSlots(seats)).toEqual([2, null]);
  });

  it('re-maps a returning player to whatever slot it got, and it is missing until motion is ok', () => {
    const seats = twoSeats();
    expect(seatOut(seats, 1)).toBe(0);
    expect(seatSlots(seats)).toEqual([null, 3]);
    expect(missingPlayers(seats, () => true)).toEqual([0]);
    // Alice comes back on slot 4 (her slot was taken).
    expect(seatIn(seats, 'id1', 4)).toBe(0);
    expect(seatSlots(seats)).toEqual([4, 3]);
    expect(missingPlayers(seats, () => true)).toEqual([0]);
    expect(seatReady(seats, 4)).toBe(0);
    expect(missingPlayers(seats, () => true)).toEqual([]);
  });

  it('never gives a match player to a new id, even on the old slot number: it is a watcher', () => {
    const seats = twoSeats();
    seatOut(seats, 1);
    expect(seatIn(seats, 'stranger', 1)).toBe(-1);
    expect(seatSlots(seats)).toEqual([null, 3]);
    expect(seatReady(seats, 1)).toBe(-1);
    expect(missingPlayers(seats, () => true)).toEqual([0]);
  });

  it('unbinds a slot a match player no longer holds if a new id lands on it without an out first', () => {
    const seats = twoSeats();
    expect(seatIn(seats, 'stranger', 3)).toBe(-1);
    expect(seatSlots(seats)).toEqual([1, null]);
    expect(missingPlayers(seats, () => true)).toEqual([1]);
  });

  it('counts a connected but silent phone as missing', () => {
    const seats = twoSeats();
    expect(missingPlayers(seats, (slot) => slot !== 3)).toEqual([1]);
  });

  it('keyboard takeover stops the wait; the phone takes its player back once motion is ok', () => {
    const seats = twoSeats();
    seatOut(seats, 1);
    expect(takeOverWithKeyboard(seats, missingPlayers(seats, () => true))).toEqual([0]);
    expect(missingPlayers(seats, () => true)).toEqual([]);
    seatIn(seats, 'id1', 2);
    expect(seats[0].keyboard).toBe(true);
    expect(missingPlayers(seats, () => true)).toEqual([]);
    seatReady(seats, 2);
    expect(seats[0]).toMatchObject({ slot: 2, ready: true, keyboard: false });
  });

  it('names the missing players', () => {
    const seats = twoSeats();
    expect(waitingText(seats, [0])).toBe("Waiting for Alice's phone");
    expect(waitingText(seats, [0, 1])).toBe("Waiting for Alice's and Bob's phones");
  });
});

describe('phone records by id', () => {
  it('keeps join order and colour when the same id comes back on another slot, and drops the old card', () => {
    const phones = new Map([[1, phone(1, 1, { id: 'pa', name: 'Alice', color: '#123456', connected: false, leftAt: 5 })]]);
    let seq = 1;
    const p = phoneJoined(phones, 2, 'Alice', 'pa', () => ++seq);
    expect(p).toEqual({ slot: 2, name: 'Alice', color: '#123456', connected: true, seq: 1, id: 'pa' });
    expect([...phones.keys()]).toEqual([2]);
  });

  it('a new id on a known slot is a new person at the back of the queue', () => {
    const phones = new Map([[1, phone(1, 1, { id: 'pa', name: 'Alice', connected: false })]]);
    let seq = 1;
    const p = phoneJoined(phones, 1, 'Alice', 'pb', () => ++seq);
    expect(p).toMatchObject({ slot: 1, id: 'pb', seq: 2, color: null });
  });

  it('lists cards of phones gone longer than the hold, except ones kept', () => {
    const phones = new Map([
      [1, phone(1, 1, { connected: false, leftAt: 0 })],
      [2, phone(2, 2, { connected: false, leftAt: 50_000 })],
      [3, phone(3, 3)],
      [4, phone(4, 4, { connected: false, leftAt: 0, id: 'keep' })],
    ]);
    expect(expiredSlots(phones, 61_000, (p) => p.id === 'keep')).toEqual([1]);
  });
});
