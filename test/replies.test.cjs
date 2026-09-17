/* eslint-disable @typescript-eslint/no-require-imports, n/no-unpublished-require -- Test-only CommonJS harness for the compiled module. */
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

// Compile the real class; replace only Companion's host boundary and timers.
const source = ts.transpileModule(readFileSync(join(__dirname, '../src/main.ts'), 'utf8'), {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const status = {
	Ok: 'ok',
	Connecting: 'connecting',
	ConnectionFailure: 'connection_failure',
	UnknownError: 'unknown_error',
	Disconnected: 'disconnected',
}
class Host {
	logs = []
	variables = {}
	log(level, message) {
		this.logs.push({ level, message })
	}
	updateStatus(value) {
		this.status = value
	}
	setVariableValues(values) {
		Object.assign(this.variables, values)
	}
}
class Socket extends EventEmitter {
	isConnected = true
	destroyed = false
	destroy() {
		this.destroyed = true
	}
}
const context = {
	exports: {},
	Buffer,
	setInterval: () => 1,
	clearInterval: () => {},
	require: (name) =>
		name.startsWith('node:')
			? require(name)
			: name === '@companion-module/base'
				? { InstanceBase: Host, InstanceStatus: status, TCPHelper: Socket, runEntrypoint() {} }
				: {},
}
vm.runInNewContext(source, context)
function instance() {
	const result = new context.exports.ModuleInstance({})
	result.config = { host: '127.0.0.1', port: 20036 }
	result.initTCP()
	return result
}
const success = Buffer.from('a55aaa55110000018001000000ff020101', 'hex')
const rejected = Buffer.from('a55aaa550e0000018000110000ff', 'hex')
const errors = (m) => m.logs.filter((entry) => entry.level === 'error')

test('bare command errors are reported without destroying the connection', () => {
	const m = instance()
	m.tcp.emit('data', success)
	m.tcp.emit('data', Buffer.from([2, 0]))
	assert.match(errors(m)[0]?.message ?? '', /checksum/)
	assert.equal(m.status, status.UnknownError)
	assert.equal(m.connectionEstablished, true)
	assert.equal(m.tcp.destroyed, false)
})
test('all handshake split points and one-byte delivery connect', () => {
	for (let split = 1; split < success.length; split++) {
		const m = instance()
		m.tcp.emit('data', success.subarray(0, split))
		assert.equal(m.connectionEstablished, false)
		m.tcp.emit('data', success.subarray(split))
		assert.equal(m.status, status.Ok)
		assert.equal(m.socketId, 1)
	}
	const m = instance()
	for (const byte of success) m.tcp.emit('data', Buffer.from([byte]))
	assert.equal(m.status, status.Ok)
})
test('combined handshake and errors, including split error, are each consumed once', () => {
	const m = instance()
	m.tcp.emit('data', Buffer.concat([success, Buffer.from([2, 0, 0x1a])]))
	assert.equal(errors(m).length, 1)
	m.tcp.emit('data', Buffer.from([0]))
	assert.equal(errors(m).length, 2)
	assert.match(errors(m)[1].message, /parameter/)
})
test('both rejection formats close the socket and preserve error state', () => {
	for (const packet of [rejected, Buffer.from([0x11, 0])]) {
		for (let split = 1; split < packet.length; split++) {
			const m = instance()
			const socket = m.tcp
			socket.emit('data', packet.subarray(0, split))
			socket.emit('data', packet.subarray(split))
			assert.equal(m.status, status.ConnectionFailure)
			assert.equal(m.variables.connection_state, 'Error')
			assert.equal(m.connectionEstablished, false)
			assert.equal(socket.destroyed, true)
			assert.equal(m.keepAliveInterval, null)
			assert.match(errors(m)[0]?.message ?? '', /limit|connections/)
		}
	}
})
test('reserved and unknown codes are not misreported as connection limits', () => {
	const m = instance()
	m.tcp.emit('data', Buffer.from([0x10, 0, 0x77, 0]))
	assert.equal(errors(m).length, 2)
	assert.match(errors(m)[0].message, /Reserved/)
	assert.match(errors(m)[1].message, /Unknown.*0x77/)
	assert.equal(m.tcp.destroyed, false)
})
test('reconnect clears partial data, stale connection state, and keepalive', () => {
	const m = instance()
	const socket = m.tcp
	socket.emit('data', success)
	socket.emit('data', Buffer.from([2]))
	socket.emit('end')
	assert.equal(m.connectionEstablished, false)
	assert.equal(m.socketId, null)
	assert.equal(m.keepAliveInterval, null)
	socket.emit('connect')
	assert.equal(m.status, status.Connecting)
	socket.emit('data', success)
	assert.equal(m.status, status.Ok)
	assert.equal(errors(m).length, 0)
})
test('unknown framed replies do not interpret payload as an error', () => {
	const m = instance()
	const unknown = Buffer.from('a55aaa550e0000021300020000ff', 'hex')
	m.tcp.emit('data', Buffer.concat([unknown, success]))
	assert.equal(m.status, status.Ok)
	assert.equal(errors(m).length, 0)
})

test('invalid replies fail without accepting trailing data as a handshake', () => {
	for (const packet of [
		Buffer.from('a55b', 'hex'),
		Buffer.from('a55aaa550000', 'hex'),
		Buffer.from('a55aaa550d00', 'hex'),
		Buffer.from('0201', 'hex'),
		Buffer.from('a55aaa550e0000018001000000ff', 'hex'),
	]) {
		const m = instance()
		m.tcp.emit('data', Buffer.concat([packet, success]))
		assert.equal(m.status, status.ConnectionFailure)
		assert.equal(m.connectionEstablished, false)
		assert.equal(m.variables.connection_state, 'Error')
	}
})

test('rejection discards remaining replies in the same TCP chunk', () => {
	const m = instance()
	m.tcp.emit('data', Buffer.concat([rejected, success]))
	assert.equal(m.status, status.ConnectionFailure)
	assert.equal(m.connectionEstablished, false)
})

test('socket errors and explicit destruction reset the receive session', () => {
	for (const action of [(m) => m.tcp.emit('error', new Error('reset')), (m) => m.destroyTCP()]) {
		const m = instance()
		m.tcp.emit('data', success)
		m.tcp.emit('data', Buffer.from([2]))
		action(m)
		assert.equal(m.connectionEstablished, false)
		assert.equal(m.socketId, null)
		assert.equal(m.keepAliveInterval, null)
		m.initTCP()
		m.tcp.emit('data', success)
		assert.equal(m.status, status.Ok)
	}
})
