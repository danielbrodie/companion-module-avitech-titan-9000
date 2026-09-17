import { InstanceStatus, TCPHelper, type LogLevel } from '@companion-module/base'
import type { ModuleConfig } from './config.js'
import type { TitanClock, TitanEvent, TitanTransport } from './titan-session.js'

interface CompanionSessionHost {
	config: ModuleConfig
	updateStatus(status: InstanceStatus, message?: string): void
	setVariableValues(values: Record<string, string | number>): void
	log(level: LogLevel, message: string): void
}

export function createTitanTransport(host: string, port: number): TitanTransport {
	return new TCPHelper(host, port)
}

export const systemClock: TitanClock = {
	every(milliseconds, callback) {
		const timer = setInterval(callback, milliseconds)
		return () => clearInterval(timer)
	},
}

// This is the only translation from device facts to Companion presentation.
export function presentTitanEvent(host: CompanionSessionHost, event: TitanEvent): void {
	switch (event.type) {
		case 'connecting':
			host.updateStatus(InstanceStatus.Connecting)
			break
		case 'transport-connected':
			host.updateStatus(InstanceStatus.Connecting)
			host.setVariableValues({ connection_state: 'Connecting' })
			host.log('info', `TCP socket connected to ${host.config.host}:${host.config.port}`)
			break
		case 'transport-error':
			host.updateStatus(InstanceStatus.ConnectionFailure)
			host.setVariableValues({ connection_state: 'Error' })
			host.log('error', `TCP error: ${event.message}`)
			break
		case 'transport-ended':
			host.updateStatus(InstanceStatus.Disconnected)
			host.setVariableValues({ connection_state: 'Disconnected' })
			break
		case 'destroyed':
			host.setVariableValues({ connection_state: 'Disconnected' })
			break
		case 'connection-failed':
			host.updateStatus(InstanceStatus.ConnectionFailure, event.message)
			host.setVariableValues({ connection_state: 'Error' })
			host.log('error', event.message)
			break
		case 'command-error':
			host.log('error', event.message)
			host.updateStatus(InstanceStatus.UnknownError, event.message)
			break
		case 'received':
			host.log('debug', `Received data: ${event.hex}`)
			break
		case 'unrecognized-reply':
			host.log('debug', `Ignoring unrecognized framed reply: ${event.hex}`)
			break
		case 'ready':
			host.updateStatus(InstanceStatus.Ok)
			host.setVariableValues({ connection_state: 'Connected' })
			host.log('info', `Connected to Avitech ${event.machineType} at ${host.config.host}:${host.config.port}`)
			host.log('debug', `Socket ID: ${event.socketId}, Machine Type: ${event.machineType}`)
			break
		case 'send-skipped':
			host.log('warn', 'Cannot send command, not connected to device')
			break
		case 'command-sending':
			host.log('debug', `Sending command: ${event.command}`)
			host.log('debug', `Binary format: ${event.hex}`)
			host.log('debug', `Checksum: 0x${event.checksum.toString(16).toUpperCase()}`)
			break
		case 'command-sent':
			host.log('debug', 'Command sent successfully')
			break
		case 'keepalive-sending':
			host.log('debug', 'Sending keep-alive packet')
			break
		case 'keepalive-sent':
			host.log('debug', 'Keep-alive packet sent')
			break
	}
}
