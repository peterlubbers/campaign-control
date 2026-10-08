import {createProvider} from './provider.mjs';
import {SettingsError, saveAISettings, validateSettings} from './config.mjs';
import {catalogModel, modelCatalog, resolveSelection, concreteLegacySelection} from './model-catalog.mjs';

export class AISettings {
  constructor({config,env = process.env,providerFactory = selection => createProvider({...selection,env}),saveSettings = saveAISettings,catalog = modelCatalog()}) {
    this.configPath = config.configPath;
    this.env = env;
    this.selection = {provider:config.provider,model:config.model};
    this.ignoredOverrides = config.ignoredModelOverrides || [];
    this.providerFactory = providerFactory;
    this.saveSettings = saveSettings;
    this.catalog = catalog;
    this.providers = new Map();
    this.saving = false;
  }
  adapter(selection) {
    const key = JSON.stringify([selection.provider,selection.model]);
    if (!this.providers.has(key)) this.providers.set(key,this.providerFactory({provider:selection.provider,model:selection.model}));
    return this.providers.get(key);
  }
  providerStatus() {
    return {...this.adapter(this.selection).providerStatus(),listed:Boolean(catalogModel(this.selection,this.catalog.models))};
  }
  forNewRun() {
    let selection;
    try {selection = resolveSelection(this.selection,this.catalog);}
    catch {throw new SettingsError('Choose a supported model in AI settings before starting a new update.');}
    const provider = this.adapter(selection);
    if (!provider.providerStatus().configured) throw new SettingsError(provider.providerStatus().message || 'Configure this provider’s API credential in the server environment before starting a run.');
    return {selection,provider};
  }
  forRun(run) {
    const selection = concreteLegacySelection(run);
    if (!selection) throw new SettingsError('This version has ambiguous legacy model provenance. Existing work and valid downloads remain available; start a new version for further AI operations.');
    const provider = this.adapter(selection);
    if (!provider.providerStatus().configured) throw new SettingsError(provider.providerStatus().message || 'Configure this version’s provider credential on the server before further AI operations.');
    return provider;
  }
  versionStatus(run) {
    if (!run || run.status === 'draft') return null;
    const selection = concreteLegacySelection(run);
    if (!selection) return {selection:run.aiSelection || run.provider || null,canContinue:false,message:'Legacy model provenance is ambiguous. Start a new version for further AI operations; existing work and valid downloads remain available.'};
    const status = this.adapter(selection).providerStatus();
    return {selection,...status,canContinue:status.configured,message:status.configured ? null : status.message};
  }
  state() {
    return {selection:this.selection,catalog:this.catalog,ignoredOverrides:this.ignoredOverrides,saving:this.saving,credentials:{openai:Boolean(this.env.OPENAI_API_KEY),anthropic:Boolean(this.env.ANTHROPIC_API_KEY)}};
  }
  async save(engine, input) {
    const next = validateSettings(input);
    engine.idle();
    if (this.saving || ['interpreting','proposing','rendering','checking'].includes(engine.run?.status)) throw new SettingsError('Wait for the current operation before changing AI settings.');
    // Take the same lock as run starts, before the first await.
    engine.busy = true; this.saving = true;
    try {
      this.adapter(next); // Validate construction before committing the file. No request is sent.
      await this.saveSettings(this.configPath,next);
      this.selection = next;
    } finally {this.saving = false; engine.busy = false;}
  }
}
