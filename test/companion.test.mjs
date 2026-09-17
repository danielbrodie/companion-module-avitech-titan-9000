/* eslint-disable n/no-unpublished-import -- Tests import the production build, which is generated before testing. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { TitanSession } from '../dist/titan-session.js'
import { presentTitanEvent } from '../dist/companion-session.js'
import { UpdateActions } from '../dist/actions.js'
import { UpdateFeedbacks } from '../dist/feedbacks.js'
import { TestClock, TestTransport } from './helpers/fakes.mjs'

const baseline = JSON.parse(readFileSync(new URL('./fixtures/baseline.json', import.meta.url), 'utf8'))

for (const scenario of baseline.scenarios) {
	test(`baseline compatibility: ${scenario.name}`, async (t) => {
		const trace = [],
			transports = [],
			clock = new TestClock()
		const host = {
			config: { host: '127.0.0.1', port: 20036 },
			variables: {},
			log: (level, message) => trace.push(['log', level, message]),
			updateStatus: (status, message) => trace.push(['status', status, message ?? null]),
			setVariableValues(values) {
				Object.assign(this.variables, values)
				trace.push(['variables', values])
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
			checkFeedbacks: (id) => trace.push(['feedback', id]),
			sendCommand: (command) => session.sendCommand(command),
		}
		const session = new TitanSession({
			createTransport: () => {
				const socket = new TestTransport()
				transports.push(socket)
				return socket
			},
			clock,
			onEvent: (event) => presentTitanEvent(host, event),
		})
		t.after(() => session.destroy())
		host.setVariableValues({ preset_number: 1, group_number: 1, connection_state: 'Disconnected' })
		session.connect(host.config.host, host.config.port)
		UpdateActions(host)
		UpdateFeedbacks(host)
		for (const [action, a, b] of scenario.steps) {
			const socket = transports.at(-1)
			if (action === 'connect') socket.connect()
			if (action === 'receive') socket.receive(a)
			if (action === 'recall') await host.actions.preset_recall.callback({ options: { group: a, preset: b } })
			if (action === 'command') session.sendCommand(a)
			if (action === 'advance') clock.advance(a)
			if (action === 'end') socket.end()
			if (action === 'error') socket.fail(a)
			if (action === 'restart') session.connect(host.config.host, host.config.port)
			if (action === 'destroy') {
				host.log('debug', 'destroy')
				session.destroy()
			}
		}
		assert.deepEqual(
			{
				trace,
				packets: transports.flatMap((s) => s.packets),
				variables: host.variables,
				feedback: host.feedbacks.preset_loaded.callback({
					options: { group: host.variables.group_number, preset: host.variables.preset_number },
				}),
			},
			scenario.expected,
		)
	})
}
