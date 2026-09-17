import { EventEmitter } from 'node:events'

export class TestTransport extends EventEmitter {
	isConnected = false
	destroyed = false
	packets = []
	connect() {
		this.isConnected = true
		this.emit('connect')
	}
	receive(hex) {
		this.emit('data', Buffer.from(hex, 'hex'))
	}
	end() {
		this.isConnected = false
		this.emit('end')
	}
	fail(message) {
		this.isConnected = false
		this.emit('error', new Error(message))
	}
	send(packet) {
		this.packets.push(packet.toString('hex'))
		return Promise.resolve(true)
	}
	destroy() {
		this.destroyed = true
		this.isConnected = false
		this.removeAllListeners()
	}
}

export class TestClock {
	now = 0
	jobs = new Set()
	every(milliseconds, callback) {
		const job = { milliseconds, callback, next: this.now + milliseconds }
		this.jobs.add(job)
		return () => this.jobs.delete(job)
	}
	advance(milliseconds) {
		const target = this.now + milliseconds
		while (true) {
			const job = [...this.jobs].filter((j) => j.next <= target).sort((a, b) => a.next - b.next)[0]
			if (!job) break
			this.now = job.next
			job.next += job.milliseconds
			job.callback()
		}
		this.now = target
	}
}
