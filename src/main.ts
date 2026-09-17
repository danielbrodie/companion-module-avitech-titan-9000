import { Buffer } from 'node:buffer'

import {
	InstanceBase,
	runEntrypoint,
	InstanceStatus,
	SomeCompanionConfigField,
	TCPHelper,
} from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'

export class ModuleInstance extends InstanceBase<ModuleConfig> {
	config!: ModuleConfig // Setup in init()
	tcp: TCPHelper | null = null
	currentPreset: number = 1
	currentGroup: number = 1
	keepAliveInterval: any = null
	connectionEstablished: boolean = false
	socketId: number | null = null
	private receiveBuffer: Buffer = Buffer.alloc(0)

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config

		// Initialize variables with default values
		this.setVariableValues({
			preset_number: this.currentPreset,
			group_number: this.currentGroup,
			connection_state: 'Disconnected',
		})

		// Initialize TCP connection
		this.initTCP()

		this.updateActions() // export actions
		this.updateFeedbacks() // export feedbacks
		this.updateVariableDefinitions() // export variable definitions
	}

	// When module gets deleted
	async destroy(): Promise<void> {
		this.log('debug', 'destroy')
		this.destroyTCP()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		const oldConfig = this.config
		this.config = config

		// If IP changed, reinitialize connection
		if (oldConfig.host !== config.host) {
			this.destroyTCP()
			this.initTCP()
		}
	}

	// Return config fields for web config
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}

	// Initialize TCP connection to the device
	initTCP(): void {
		if (this.tcp !== null) {
			this.destroyTCP()
		}

		this.updateStatus(InstanceStatus.Connecting)
		this.resetSession()

		// Use the port from the config (which is set to 20036 by default)
		this.tcp = new TCPHelper(this.config.host, this.config.port)

		this.tcp.on('connect', () => {
			this.resetSession()
			this.updateStatus(InstanceStatus.Connecting)
			this.setVariableValues({ connection_state: 'Connecting' })
			this.log('info', `TCP socket connected to ${this.config.host}:${this.config.port}`)
			// Connection is established, but we need to wait for the handshake response
			// The device will send a handshake message upon connection
		})

		this.tcp.on('error', (err) => {
			this.resetSession()
			this.updateStatus(InstanceStatus.ConnectionFailure)
			this.setVariableValues({ connection_state: 'Error' })
			this.log('error', `TCP error: ${err.message}`)
			this.stopKeepAlive()
		})

		this.tcp.on('end', () => {
			this.resetSession()
			this.updateStatus(InstanceStatus.Disconnected)
			this.setVariableValues({ connection_state: 'Disconnected' })
		})

		this.tcp.on('data', (data) => {
			this.processIncomingData(data)
		})
	}

	// Start the keep-alive mechanism to prevent the 8-minute timeout
	startKeepAlive(): void {
		// Clear any existing interval
		this.stopKeepAlive()

		// Set up a new interval to send a keep-alive packet every 7 minutes (420000 ms)
		// This is less than the 8-minute timeout mentioned in the documentation
		this.keepAliveInterval = setInterval(() => {
			if (this.tcp && this.tcp.isConnected && this.connectionEstablished) {
				this.log('debug', 'Sending keep-alive packet')
				// According to section B.4 of the documentation, any TCP message will prevent timeout
				// We'll send a minimal packet that won't affect the device state
				if (this.tcp) {
					// Create a minimal valid packet with proper header but no command
					// This is just to keep the connection alive without changing device state
					const totalLength = 15 // Header (4) + fixed fields (10) + checksum (1)
					const buffer = Buffer.alloc(totalLength)
					// Header (bytes 0-3)
					buffer[0] = 0x55
					buffer[1] = 0xaa
					buffer[2] = 0x5a
					buffer[3] = 0xa5
					// Command length (bytes 4-5, little-endian)
					buffer.writeUInt16LE(totalLength, 4)
					// Reserved (byte 6)
					buffer[6] = 0x00
					// Command ID (bytes 7-8) - using 0x00 0x00 for a no-op
					buffer[7] = 0x00
					buffer[8] = 0x00
					// Frame ID (byte 9)
					buffer[9] = 0x00
					// Inverse Frame ID (byte 10)
					buffer[10] = 0xff
					// Fixed value (byte 11)
					buffer[11] = 0x01
					// Module ID (byte 12)
					buffer[12] = 0xfe
					// Fixed value (byte 13)
					buffer[13] = 0x00

					// Calculate checksum (last byte)
					let checksum = 0
					for (let i = 0; i < totalLength - 1; i++) {
						checksum = (checksum + buffer[i]) & 0xff
					}
					buffer[totalLength - 1] = checksum

					void this.tcp.send(buffer)
					this.log('debug', 'Keep-alive packet sent')
				}
			}
		}, 420000) // 7 minutes
	}

	// Stop the keep-alive mechanism
	stopKeepAlive(): void {
		if (this.keepAliveInterval) {
			clearInterval(this.keepAliveInterval)
			this.keepAliveInterval = null
		}
	}

	// Clean up TCP connection
	destroyTCP(): void {
		this.stopKeepAlive()

		if (this.tcp !== null) {
			this.tcp.destroy()
			this.tcp = null
		}

		this.resetSession()
		this.setVariableValues({ connection_state: 'Disconnected' })
	}

	private resetSession(): void {
		this.stopKeepAlive()
		this.connectionEstablished = false
		this.socketId = null
		this.receiveBuffer = Buffer.alloc(0)
	}

	private failConnection(message: string): void {
		this.destroyTCP()
		this.updateStatus(InstanceStatus.ConnectionFailure, message)
		this.setVariableValues({ connection_state: 'Error' })
		this.log('error', message)
	}

	// TCP chunks may contain partial replies or several replies. B.2/B.3 use
	// length-prefixed frames; B.6 command errors are bare little-endian pairs.
	processIncomingData(data: Buffer): void {
		this.log('debug', `Received data: ${data.toString('hex')}`)
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
			this.log('debug', `Ignoring unrecognized framed reply: ${data.toString('hex')}`)
			return
		}
		if (data[9] === 0x00 && data.length === 14) {
			this.failConnection('Connection failed: Maximum number of connections reached (limit is 3)')
		} else if (data[9] === 0x01 && data.length === 17) {
			const machineType = data[14] === 0x02 ? 'Titan 9000' : 'Rainier 3G Quad'
			this.socketId = data[16]
			this.connectionEstablished = true
			this.updateStatus(InstanceStatus.Ok)
			this.setVariableValues({ connection_state: 'Connected' })
			this.log('info', `Connected to Avitech ${machineType} at ${this.config.host}:${this.config.port}`)
			this.log('debug', `Socket ID: ${this.socketId}, Machine Type: ${machineType}`)
			this.startKeepAlive()
		} else {
			this.failConnection('Invalid connection reply')
		}
	}

	private reportCommandError(code: number): void {
		// ASCII X guide B.6, Table B-3. These are not fields in a framed reply.
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
		if (code === 0x11) {
			this.failConnection(message)
		} else {
			this.log('error', message)
			// An unsuccessful command does not imply a broken TCP connection.
			// Keep the error visible until a new successful handshake; B.7 has no ACK.
			this.updateStatus(InstanceStatus.UnknownError, message)
		}
	}

	/**
	 * Send a command to the Avitech Titan 9000 device
	 *
	 * This method converts ASCII commands to the binary format required by the device
	 * according to section B.7 of the Avitech Titan 9000 documentation.
	 *
	 * The binary format consists of:
	 * - Header (4 bytes): 0x55 0xAA 0x5A 0xA5
	 * - Command length (2 bytes, little-endian)
	 * - Reserved byte (1 byte): 0x00
	 * - Command ID (2 bytes): 0x02 0x13
	 * - Frame ID (1 byte): 0x00
	 * - Inverse Frame ID (1 byte): 0xFF
	 * - Fixed value (1 byte): 0x01
	 * - Module ID (1 byte): 0xFE
	 * - Fixed value (1 byte): 0x00
	 * - ASCII command (variable length)
	 * - Checksum (1 byte): Sum modulo 256 of all previous bytes
	 *
	 * @param asciiCmd The ASCII command to send
	 */
	sendCommand(asciiCmd: string): void {
		if (this.tcp && this.tcp.isConnected && this.connectionEstablished) {
			// Remove any trailing CRLF if present
			const cleanCmd = asciiCmd.replace(/\r\n$/, '')

			// Convert ASCII command to binary format according to section B.7 of the documentation
			const cmdBytes = Buffer.from(cleanCmd, 'ascii')
			const cmdLength = cmdBytes.length
			const totalLength = 14 + cmdLength + 1 // Header (4) + fixed fields (10) + command + checksum (1)

			// Create buffer for the entire command
			const buffer = Buffer.alloc(totalLength)

			// Header (bytes 0-3)
			buffer[0] = 0x55
			buffer[1] = 0xaa
			buffer[2] = 0x5a
			buffer[3] = 0xa5

			// Command length (bytes 4-5, little-endian)
			buffer.writeUInt16LE(totalLength, 4)

			// Reserved (byte 6)
			buffer[6] = 0x00

			// Command ID (bytes 7-8)
			buffer[7] = 0x02
			buffer[8] = 0x13

			// Frame ID (byte 9)
			buffer[9] = 0x00

			// Inverse Frame ID (byte 10)
			buffer[10] = 0xff

			// Fixed value (byte 11)
			buffer[11] = 0x01

			// Module ID (byte 12)
			buffer[12] = 0xfe

			// Fixed value (byte 13)
			buffer[13] = 0x00

			// ASCII command (bytes 14+)
			cmdBytes.copy(buffer, 14)

			// Calculate checksum (last byte) using sum modulo 256
			let checksum = 0
			for (let i = 0; i < totalLength - 1; i++) {
				checksum = (checksum + buffer[i]) & 0xff // Sum modulo 256
			}
			buffer[totalLength - 1] = checksum

			this.log('debug', `Sending command: ${cleanCmd}`)
			this.log('debug', `Binary format: ${buffer.toString('hex')}`)
			this.log('debug', `Checksum: 0x${checksum.toString(16).toUpperCase()}`)

			// Send the command and consider it successful without waiting for response
			void this.tcp.send(buffer)
			this.log('debug', 'Command sent successfully')
		} else {
			this.log('warn', 'Cannot send command, not connected to device')
		}
	}
}

runEntrypoint(ModuleInstance, UpgradeScripts)
