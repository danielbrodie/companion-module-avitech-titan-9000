import { Buffer } from 'node:buffer'

export interface TitanTransport {
	readonly isConnected: boolean
	on(event: 'connect' | 'end', callback: () => void): unknown
	on(event: 'error', callback: (error: Error) => void): unknown
	on(event: 'data', callback: (data: Buffer) => void): unknown
	send(packet: Buffer): Promise<boolean>
	destroy(): void
}

export interface TitanClock {
	every(milliseconds: number, callback: () => void): () => void
}

export type TitanEvent =
	| {
			type:
				| 'connecting'
				| 'transport-connected'
				| 'transport-ended'
				| 'destroyed'
				| 'send-skipped'
				| 'command-sent'
				| 'keepalive-sending'
				| 'keepalive-sent'
	  }
	| { type: 'transport-error' | 'connection-failed' | 'command-error'; message: string }
	| { type: 'received' | 'unrecognized-reply'; hex: string }
	| { type: 'ready'; machineType: string; socketId: number }
	| { type: 'command-sending'; command: string; hex: string; checksum: number }

export interface TitanSessionOptions {
	createTransport(host: string, port: number): TitanTransport
	clock: TitanClock
	onEvent(event: TitanEvent): void
}

// One session owns readiness, stream framing and cleanup; Companion presentation
// is deliberately left to the caller. Transport adapters retain their retry policy.
export class TitanSession {
	private transport: TitanTransport | null = null
	private ready = false
	private receiveBuffer: Buffer = Buffer.alloc(0)
	private cancelKeepAlive: (() => void) | null = null

	constructor(private readonly options: TitanSessionOptions) {}

	connect(host: string, port: number): void {
		if (this.transport !== null) this.destroy()
		this.emit({ type: 'connecting' })
		this.reset()
		this.transport = this.options.createTransport(host, port)
		this.transport.on('connect', () => {
			this.reset()
			this.emit({ type: 'transport-connected' })
		})
		this.transport.on('error', (error) => {
			this.reset()
			this.emit({ type: 'transport-error', message: error.message })
		})
		this.transport.on('end', () => {
			this.reset()
			this.emit({ type: 'transport-ended' })
		})
		this.transport.on('data', (data) => this.receive(data))
	}

	destroy(): void {
		this.cancelKeepAlive?.()
		this.cancelKeepAlive = null
		this.transport?.destroy()
		this.transport = null
		this.reset()
		this.emit({ type: 'destroyed' })
	}

	sendCommand(asciiCommand: string): void {
		if (!this.transport?.isConnected || !this.ready) {
			this.emit({ type: 'send-skipped' })
			return
		}
		const command = asciiCommand.replace(/\r\n$/, '')
		const packet = this.encodePacket(0x1302, Buffer.from(command, 'ascii'))
		this.emit({ type: 'command-sending', command, hex: packet.toString('hex'), checksum: packet[packet.length - 1] })
		void this.transport.send(packet)
		this.emit({ type: 'command-sent' })
	}

	private emit(event: TitanEvent): void {
		this.options.onEvent(event)
	}

	private reset(): void {
		this.cancelKeepAlive?.()
		this.cancelKeepAlive = null
		this.ready = false
		this.receiveBuffer = Buffer.alloc(0)
	}

	private startKeepAlive(): void {
		this.cancelKeepAlive?.()
		this.cancelKeepAlive = this.options.clock.every(420000, () => {
			if (this.transport?.isConnected && this.ready) {
				this.emit({ type: 'keepalive-sending' })
				// Preserve the baseline packet; this refactor does not redefine its meaning.
				void this.transport.send(this.encodePacket(0x0000, Buffer.alloc(0)))
				this.emit({ type: 'keepalive-sent' })
			}
		})
	}

	private encodePacket(commandId: number, payload: Buffer): Buffer {
		const packet = Buffer.alloc(15 + payload.length)
		packet.set([0x55, 0xaa, 0x5a, 0xa5])
		packet.writeUInt16LE(packet.length, 4)
		packet.writeUInt16LE(commandId, 7)
		packet[10] = 0xff
		packet[11] = 0x01
		packet[12] = 0xfe
		payload.copy(packet, 14)
		let checksum = 0
		for (let i = 0; i < packet.length - 1; i++) checksum = (checksum + packet[i]) & 0xff
		packet[packet.length - 1] = checksum
		return packet
	}

	private failConnection(message: string): void {
		this.destroy()
		this.emit({ type: 'connection-failed', message })
	}

	private receive(data: Buffer): void {
		this.emit({ type: 'received', hex: data.toString('hex') })
		this.receiveBuffer = Buffer.concat([this.receiveBuffer, data])
		const header = Buffer.from([0xa5, 0x5a, 0xaa, 0x55])
		while (this.receiveBuffer.length > 0) {
			const pending = this.receiveBuffer
			if (pending[0] !== header[0]) {
				if (pending.length < 2) return
				if (pending[1] !== 0x00) {
					this.failConnection('Invalid error reply: expected a two-byte code ending in 00')
					return
				}
				this.receiveBuffer = pending.subarray(2)
				this.reportCommandError(pending[0])
				continue
			}
			const prefixLength = Math.min(pending.length, header.length)
			if (!pending.subarray(0, prefixLength).equals(header.subarray(0, prefixLength))) {
				this.failConnection('Invalid reply header')
				return
			}
			if (pending.length < 6) return
			const length = pending.readUInt16LE(4)
			if (length < 14) {
				this.failConnection(`Invalid reply length: ${length}`)
				return
			}
			if (pending.length < length) return
			const reply = pending.subarray(0, length)
			this.receiveBuffer = pending.subarray(length)
			this.processFramedReply(reply)
		}
	}

	private processFramedReply(data: Buffer): void {
		if (data[7] !== 0x01 || data[8] !== 0x80) {
			this.emit({ type: 'unrecognized-reply', hex: data.toString('hex') })
			return
		}
		if (data[9] === 0x00 && data.length === 14) {
			this.failConnection('Connection failed: Maximum number of connections reached (limit is 3)')
		} else if (data[9] === 0x01 && data.length === 17) {
			this.ready = true
			this.emit({
				type: 'ready',
				machineType: data[14] === 0x02 ? 'Titan 9000' : 'Rainier 3G Quad',
				socketId: data[16],
			})
			this.startKeepAlive()
		} else {
			this.failConnection('Invalid connection reply')
		}
	}

	private reportCommandError(code: number): void {
		// ASCII X guide B.6, Table B-3.
		const errors: Record<number, string> = {
			0x01: 'Command parsing error or command format error',
			0x02: 'Command checksum error',
			0x03: 'Frame_ID does not match',
			0x04: 'Module_ID/Module ID length does not match',
			0x05: 'Module style or sub-module style does not match real device',
			0x06: 'No such module',
			0x07: 'No such sub-module',
			0x08: 'No such processor',
			0x09: 'Command received is incomplete',
			0x0a: 'Device does not support this command',
			0x0b: 'This command does not support Multicast/Broadcast command type',
			0x0c: 'Cannot execute command in the current module state',
			0x0d: 'Command execution failed',
			0x0e: 'File already exists',
			0x0f: 'File does not exist or was not created properly',
			0x10: 'Reserved error code',
			0x11: 'Number of TCP connections has exceeded system limit (limit is 3)',
			0x12: 'Insufficient flash memory space',
			0x13: 'Data already exists at flash address',
			0x14: 'File CRC-16 check error',
			0x15: 'Already reading a file',
			0x16: 'Writing size exceeds 65535 bytes',
			0x17: 'File size exceeds 8192 bytes',
			0x18: 'Invalid preset file format',
			0x19: 'File size exceeds device limit',
			0x1a: 'Invalid input parameter',
			0x1b: 'Invalid display group ID',
			0x1c: 'Invalid display module ID',
			0xff: 'Undefined error',
		}
		const message = `Command error: ${errors[code] ?? 'Unknown error'} (0x${code.toString(16).padStart(2, '0')})`
		if (code === 0x11) this.failConnection(message)
		else this.emit({ type: 'command-error', message })
	}
}
