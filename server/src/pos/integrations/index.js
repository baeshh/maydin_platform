const { bridgeAdapter } = require('./bridge-adapter');
const { DEMO_SIMULATIONS, demoAdapter, maskIdentity } = require('./demo-adapter');
const { kisAdapter } = require('./kis-adapter');
const { manualAdapter } = require('./manual-adapter');
const { niceAdapter } = require('./nice-adapter');
const { VAN_COMPANIES, VanError, VanUnavailableError } = require('./van-adapter');

const ADAPTERS = { MANUAL: manualAdapter, DEMO: demoAdapter, BRIDGE: bridgeAdapter, NICE: niceAdapter, KIS: kisAdapter };
const VAN_MODES = Object.fromEntries(Object.entries(ADAPTERS).map(([mode, adapter]) => [mode, adapter.label]));

function adapterFor(terminal) {
  return ADAPTERS[terminal?.van_mode] || manualAdapter;
}

function vanModeOptions() {
  return Object.entries(ADAPTERS).map(([mode, adapter]) => ({
    mode,
    label: adapter.label,
    kind: adapter.kind,
    is_demo: adapter.isDemo,
    available: adapter.available(),
    requirements: adapter.requirements || []
  }));
}

module.exports = {
  ADAPTERS,
  DEMO_SIMULATIONS,
  VAN_COMPANIES,
  VAN_MODES,
  VanError,
  VanUnavailableError,
  adapterFor,
  demoAdapter,
  manualAdapter,
  maskIdentity,
  vanModeOptions
};
