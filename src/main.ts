import { InstanceBase, runEntrypoint, type SomeCompanionConfigField } from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { TitanSession } from './titan-session.js'
import { createTitanTransport, presentTitanEvent, systemClock } from './companion-session.js'

export class ModuleInstance extends InstanceBase<ModuleConfig> {
	config!: ModuleConfig
	private readonly session = new TitanSession({
		createTransport: createTitanTransport,
		clock: systemClock,
		onEvent: (event) => presentTitanEvent(this, event),
	})

	async init(config: ModuleConfig): Promise<void> {
		this.config = config
		this.setVariableValues({
			preset_number: 1,
			group_number: 1,
			connection_state: 'Disconnected',
		})
		this.session.connect(config.host, config.port)
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariableDefinitions()
	}

	async destroy(): Promise<void> {
		this.log('debug', 'destroy')
		this.session.destroy()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		const oldConfig = this.config
		this.config = config
		// Preserve the existing rule: only a host change restarts the connection.
		if (oldConfig.host !== config.host) {
			this.session.destroy()
			this.session.connect(config.host, config.port)
		}
	}

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

	sendCommand(command: string): void {
		this.session.sendCommand(command)
	}
}

runEntrypoint(ModuleInstance, UpgradeScripts)
