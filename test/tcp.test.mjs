/* eslint-disable n/no-unpublished-import -- Tests import the production build, which is generated before testing. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { test } from 'node:test'
import { InstanceStatus } from '@companion-module/base'
import { TitanSession } from '../dist/titan-session.js'
import { createTitanTransport, presentTitanEvent, systemClock } from '../dist/companion-session.js'
import { UpdateActions } from '../dist/actions.js'
import { UpdateFeedbacks } from '../dist/feedbacks.js'

const baseline = JSON.parse(readFileSync(new URL('./fixtures/baseline.json', import.meta.url), 'utf8'))
const presetPacket = baseline.scenarios[0].expected.packets[1]
const handshake = 'a55aaa55110000018001000000ff020101'

// A protocol emulator, not hardware validation. The refactor still needs a real
// Titan/Companion test before release. Keepalive timing has deterministic coverage.
test(
	'production TCP session presents handshake, preset recall, command errors and disconnect',
	{ timeout: 15000 },
	async (t) => {
		const changed = new EventEmitter()
		const sockets = new Set()
		const logs = [],
			statuses = [],
			feedbackChecks = []
		let peer, failure
		let received = Buffer.alloc(0)
		const fail = (error) => {
			failure = error
			changed.emit('change')
		}
		// Subscribe before checking: completion may already have happened. Every wait
		// has a deadline, and removes its listener and timer on either outcome.
		const waitFor = (description, predicate) =>
			new Promise((resolve, reject) => {
				const finish = (error) => {
					clearTimeout(timer)
					changed.off('change', check)
					if (error) reject(error)
					else resolve()
				}
				const check = () => {
					if (failure) finish(failure)
					else if (predicate()) finish()
				}
				const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${description}`)), 3000)
				changed.on('change', check)
				check()
			})
		const hasLog = (level, message) => logs.some(([l, m]) => l === level && m === message)
		const server = createServer((socket) => {
			peer = socket
			sockets.add(socket)
			socket.on('error', fail)
			socket.on('close', () => sockets.delete(socket))
			socket.on('data', (data) => {
				received = Buffer.concat([received, data])
				changed.emit('change')
			})
			changed.emit('change')
		})
		server.on('error', fail)
		const host = {
			config: { host: '127.0.0.1', port: 0 },
			variables: { preset_number: 1, group_number: 1, connection_state: 'Disconnected' },
			log: (level, message) => logs.push([level, message]),
			updateStatus: (status, message) => statuses.push([status, message]),
			setVariableValues(values) {
				Object.assign(this.variables, values)
			},
			getVariableValue(key) {
				return this.variables[key]
			},
			setActionDefinitions(actions) {
				this.actions = actions
			},
			setFeedbackDefinitions(feedbacks) {
				this.feedbacks = feedbacks
			},
			checkFeedbacks: (id) => feedbackChecks.push(id),
			sendCommand: (command) => session.sendCommand(command),
		}
		const session = new TitanSession({
			createTransport: createTitanTransport,
			clock: systemClock,
			onEvent: (event) => {
				presentTitanEvent(host, event)
				changed.emit('change')
			},
		})
		t.after(async () => {
			session.destroy()
			for (const socket of sockets) socket.destroy()
			await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('TCP emulator did not close')), 3000)
				server.close(() => {
					clearTimeout(timer)
					resolve()
				})
			})
		})
		server.listen(0, '127.0.0.1', () => changed.emit('change'))
		await waitFor('loopback listener', () => server.listening)
		host.config.port = server.address().port
		assert.equal(server.address().address, '127.0.0.1')
		UpdateActions(host)
		UpdateFeedbacks(host)
		session.connect(host.config.host, host.config.port)
		await waitFor('TCP connection', () => peer && host.variables.connection_state === 'Connecting')
		assert.equal(statuses.at(-1)[0], InstanceStatus.Connecting)
		assert.ok(hasLog('info', `TCP socket connected to 127.0.0.1:${host.config.port}`))
		session.sendCommand('XP 001000000 L preset1.GP1')
		assert.ok(hasLog('warn', 'Cannot send command, not connected to device'))

		// Wait for the first fragment to reach the presentation before sending the
		// remainder, so TCP coalescing cannot turn this into an unsplit handshake.
		peer.write(Buffer.from(handshake.slice(0, 12), 'hex'))
		await waitFor(
			'handshake fragment',
			() =>
				logs
					.filter(([level, message]) => level === 'debug' && message.startsWith('Received data: '))
					.map(([, message]) => message.slice('Received data: '.length))
					.join('') === handshake.slice(0, 12),
		)
		assert.equal(host.variables.connection_state, 'Connecting')
		assert.equal(received.length, 0)
		peer.write(Buffer.from(handshake.slice(12), 'hex'))
		await waitFor('Titan acceptance', () => host.variables.connection_state === 'Connected')
		assert.equal(statuses.at(-1)[0], InstanceStatus.Ok)
		assert.ok(hasLog('info', `Connected to Avitech Titan 9000 at 127.0.0.1:${host.config.port}`))
		assert.ok(hasLog('debug', 'Socket ID: 1, Machine Type: Titan 9000'))

		const recall = () => host.actions.preset_recall.callback({ options: { group: 99, preset: 14 } })
		await recall()
		await waitFor('preset packet', () => received.length >= presetPacket.length / 2)
		assert.equal(received.toString('hex'), presetPacket)
		assert.deepEqual(host.variables, { preset_number: 14, group_number: 99, connection_state: 'Connected' })
		assert.deepEqual(feedbackChecks, ['preset_loaded'])
		assert.equal(host.feedbacks.preset_loaded.callback({ options: { group: 99, preset: 14 } }), true)
		assert.equal(host.feedbacks.preset_loaded.callback({ options: { group: 1, preset: 2 } }), false)
		assert.ok(hasLog('debug', 'Command sent successfully'))

		// Two bare errors share a write; assertions concern the resulting stream,
		// not how the operating system divides it into data events.
		peer.write(Buffer.from('02001a00', 'hex'))
		const checksumError = 'Command error: Command checksum error (0x02)'
		const parameterError = 'Command error: Invalid input parameter (0x1a)'
		await waitFor('both command errors', () => hasLog('error', checksumError) && hasLog('error', parameterError))
		assert.deepEqual(statuses.slice(-2), [
			[InstanceStatus.UnknownError, checksumError],
			[InstanceStatus.UnknownError, parameterError],
		])
		assert.equal(host.variables.connection_state, 'Connected')
		await recall()
		await waitFor('command after error', () => received.length >= presetPacket.length)
		assert.equal(received.toString('hex'), presetPacket + presetPacket)
		assert.deepEqual(statuses.at(-1), [InstanceStatus.UnknownError, parameterError])

		peer.end()
		await waitFor('disconnect presentation', () => host.variables.connection_state === 'Disconnected')
		assert.equal(statuses.at(-1)[0], InstanceStatus.Disconnected)
		const logCount = logs.length
		session.sendCommand('XP 001000000 L preset1.GP1')
		assert.deepEqual(logs.slice(logCount), [['warn', 'Cannot send command, not connected to device']])
		assert.equal(received.toString('hex'), presetPacket + presetPacket)
	},
)
