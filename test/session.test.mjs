/* eslint-disable n/no-unpublished-import -- Tests import the production build, which is generated before testing. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { TitanSession } from '../dist/titan-session.js'
import { TestClock, TestTransport } from './helpers/fakes.mjs'

const success = 'a55aaa55110000018001000000ff020101'
const rejected = 'a55aaa550e0000018000110000ff'
const baseline = JSON.parse(readFileSync(new URL('./fixtures/baseline.json', import.meta.url), 'utf8'))
const command = 'XP 001000000 L preset1.GP1'
const commandPacket = baseline.scenarios[0].expected.packets[0]
const keepAlivePacket = baseline.scenarios.find((s) => s.name === 'keepalive gating and disconnect').expected.packets[0]
function setup() {
	const events = [],
		transports = [],
		clock = new TestClock()
	const session = new TitanSession({
		createTransport: () => {
			const transport = new TestTransport()
			transports.push(transport)
			return transport
		},
		clock,
		onEvent: (event) => events.push(event),
	})
	session.connect('127.0.0.1', 20036)
	return { session, events, transports, clock, socket: transports[0] }
}

test('a Titan handshake enables command transmission; TCP connectivity alone does not', () => {
	const { session, socket, events } = setup()
	socket.connect()
	session.sendCommand('XP 001000000 L preset1.GP1')
	assert.deepEqual(socket.packets, [])
	assert.equal(events.at(-1).type, 'send-skipped')
	socket.receive(success)
	assert.deepEqual(events.at(-1), { type: 'ready', machineType: 'Titan 9000', socketId: 1 })
	session.sendCommand('XP 001000000 L preset1.GP1')
	assert.equal(socket.packets.length, 1)
	session.destroy()
})

test('bare command errors remain visible while an established session can send', () => {
	const { session, socket, events } = setup()
	socket.connect()
	socket.receive(success)
	socket.receive('0200')
	assert.deepEqual(events.at(-1), { type: 'command-error', message: 'Command error: Command checksum error (0x02)' })
	session.sendCommand(command)
	assert.deepEqual(socket.packets, [commandPacket])
	assert.equal(socket.destroyed, false)
	session.destroy()
})

test('every handshake split point and one-byte delivery establish readiness', () => {
	for (let split = 2; split < success.length; split += 2) {
		const { session, socket, events } = setup()
		socket.connect()
		socket.receive(success.slice(0, split))
		assert.equal(
			events.some((e) => e.type === 'ready'),
			false,
		)
		socket.receive(success.slice(split))
		session.sendCommand(command)
		assert.deepEqual(socket.packets, [commandPacket])
		session.destroy()
	}
	const { session, socket } = setup()
	socket.connect()
	for (let i = 0; i < success.length; i += 2) socket.receive(success.slice(i, i + 2))
	session.sendCommand(command)
	assert.deepEqual(socket.packets, [commandPacket])
	session.destroy()
})

test('combined replies and a split error are consumed exactly once', () => {
	const { session, socket, events } = setup()
	socket.connect()
	socket.receive(success + '02001a')
	assert.equal(events.filter((e) => e.type === 'command-error').length, 1)
	socket.receive('00')
	assert.deepEqual(
		events.filter((e) => e.type === 'command-error').map((e) => e.message),
		['Command error: Command checksum error (0x02)', 'Command error: Invalid input parameter (0x1a)'],
	)
	session.destroy()
})

test('both rejection formats close the transport at every split point', () => {
	for (const packet of [rejected, '1100'])
		for (let split = 2; split < packet.length; split += 2) {
			const { session, socket, events, clock } = setup()
			socket.connect()
			socket.receive(packet.slice(0, split))
			socket.receive(packet.slice(split))
			assert.equal(events.at(-1).type, 'connection-failed')
			assert.equal(socket.destroyed, true)
			session.sendCommand(command)
			clock.advance(840000)
			assert.deepEqual(socket.packets, [])
			session.destroy()
		}
})

test('reserved and unknown codes are reported without connection-limit handling', () => {
	const { session, socket, events } = setup()
	socket.connect()
	socket.receive('10007700')
	assert.deepEqual(
		events.filter((e) => e.type === 'command-error').map((e) => e.message),
		['Command error: Reserved error code (0x10)', 'Command error: Unknown error (0x77)'],
	)
	assert.equal(socket.destroyed, false)
	session.destroy()
})

test('reconnect discards a partial reply and requires a new handshake', () => {
	const { session, socket, events, clock } = setup()
	socket.connect()
	socket.receive(success)
	socket.receive('02')
	socket.end()
	clock.advance(420000)
	session.sendCommand(command)
	assert.deepEqual(socket.packets, [])
	socket.connect()
	session.sendCommand(command)
	assert.deepEqual(socket.packets, [])
	socket.receive(success)
	session.sendCommand(command)
	assert.deepEqual(socket.packets, [commandPacket])
	assert.equal(
		events.some((e) => e.type === 'command-error'),
		false,
	)
	session.destroy()
})

test('unknown framed replies do not turn payload bytes into command errors', () => {
	const { session, socket, events } = setup()
	socket.connect()
	socket.receive('a55aaa550e0000021300020000ff' + success)
	session.sendCommand(command)
	assert.deepEqual(socket.packets, [commandPacket])
	assert.equal(
		events.some((e) => e.type === 'command-error'),
		false,
	)
	session.destroy()
})

test('malformed replies close the connection and discard trailing handshakes', () => {
	for (const packet of ['a55b', 'a55aaa550000', 'a55aaa550d00', '0201', 'a55aaa550e0000018001000000ff']) {
		const { session, socket, events } = setup()
		socket.connect()
		socket.receive(packet + success)
		assert.equal(events.at(-1).type, 'connection-failed')
		assert.equal(
			events.some((e) => e.type === 'ready'),
			false,
		)
		session.sendCommand(command)
		assert.deepEqual(socket.packets, [])
		assert.equal(socket.destroyed, true)
		session.destroy()
	}
})

test('connection rejection discards remaining replies in the same chunk', () => {
	for (const packet of [rejected, '1100']) {
		const { session, socket, events } = setup()
		socket.connect()
		socket.receive(packet + success)
		assert.equal(events.at(-1).type, 'connection-failed')
		assert.equal(
			events.some((e) => e.type === 'ready'),
			false,
		)
		session.destroy()
	}
})

test('socket failure and explicit destruction clear readiness, partial replies and scheduling', () => {
	for (const stop of [(r) => r.socket.fail('reset'), (r) => r.session.destroy()]) {
		const r = setup()
		r.socket.connect()
		r.socket.receive(success)
		r.socket.receive('02')
		stop(r)
		r.clock.advance(840000)
		r.session.sendCommand(command)
		assert.deepEqual(r.socket.packets, [])
		r.session.connect('127.0.0.1', 20036)
		const next = r.transports.at(-1)
		next.connect()
		next.receive(success)
		r.session.sendCommand(command)
		assert.deepEqual(next.packets, [commandPacket])
		assert.equal(
			r.events.some((e) => e.type === 'command-error'),
			false,
		)
		r.session.destroy()
	}
})

test('keepalive starts after the handshake, sends baseline bytes at seven minutes, and cancels on teardown', () => {
	const { session, socket, clock } = setup()
	socket.connect()
	clock.advance(840000)
	assert.deepEqual(socket.packets, [])
	socket.receive(success)
	clock.advance(419999)
	assert.deepEqual(socket.packets, [])
	clock.advance(1)
	assert.deepEqual(socket.packets, [keepAlivePacket])
	clock.advance(420000)
	assert.deepEqual(socket.packets, [keepAlivePacket, keepAlivePacket])
	session.destroy()
	clock.advance(840000)
	assert.equal(socket.packets.length, 2)
})

test('repeated handshakes and reconnects replace keepalive schedules', () => {
	const { session, socket, clock } = setup()
	socket.connect()
	socket.receive(success)
	clock.advance(200000)
	socket.receive(success)
	clock.advance(220000)
	assert.deepEqual(socket.packets, [])
	clock.advance(200000)
	assert.deepEqual(socket.packets, [keepAlivePacket])
	socket.end()
	socket.connect()
	socket.receive(success)
	clock.advance(420000)
	assert.deepEqual(socket.packets, [keepAlivePacket, keepAlivePacket])
	session.destroy()
})

test('transport connectivity gates command and keepalive sends even after handshake acceptance', () => {
	const { session, socket, clock } = setup()
	socket.connect()
	socket.receive(success)
	socket.isConnected = false
	session.sendCommand(command)
	clock.advance(420000)
	assert.deepEqual(socket.packets, [])
	session.destroy()
})
