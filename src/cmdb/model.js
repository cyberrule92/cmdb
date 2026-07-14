// CI type catalog — the equivalent of uCMDB's CIT (CI Type) model.
// Each type declares its category (drives UI grouping/colour) and label.
// The Redfish resource hierarchy is modelled 1:1 here:
//   Chassis ▸ Server(ComputeSystem) ▸ {Processor, Memory, Drive, Volume, EthernetInterface}
//   Chassis ▸ {NetworkAdapter, PCIeDevice, PowerSupply, Fan, TemperatureSensor}
//   Server  ▸ managed_by ▸ Manager(BMC) ▸ NetworkInterface
//   Server  ▸ {Firmware, Software}

export const CI_TYPES = {
  // compute
  Server:            { category: 'compute', label: 'Compute System',    icon: 'server' },
  Hypervisor:        { category: 'compute', label: 'Hypervisor Host',   icon: 'hypervisor' },
  VM:                { category: 'compute', label: 'Virtual Machine',    icon: 'vm' },
  Chassis:           { category: 'compute', label: 'Chassis',           icon: 'chassis' },
  Cluster:           { category: 'compute', label: 'Cluster',           icon: 'cluster' },
  // management
  Manager:           { category: 'mgmt',    label: 'Manager (BMC/iLO)', icon: 'bmc' },
  // network
  NetworkDevice:     { category: 'network', label: 'Network Device',    icon: 'switch' },
  NetworkInterface:  { category: 'network', label: 'Network Interface', icon: 'nic' },
  EthernetInterface: { category: 'network', label: 'Ethernet Interface',icon: 'nic' },
  NetworkAdapter:    { category: 'network', label: 'Network Adapter',   icon: 'nic' },
  VirtualNetwork:    { category: 'network', label: 'Virtual Network',   icon: 'vnet' },
  // storage
  Storage:           { category: 'storage', label: 'Storage Controller',icon: 'storage' },
  Drive:             { category: 'storage', label: 'Physical Drive',    icon: 'drive' },
  Volume:            { category: 'storage', label: 'Volume',            icon: 'volume' },
  Datastore:         { category: 'storage', label: 'Datastore',         icon: 'datastore' },
  Filesystem:        { category: 'storage', label: 'Filesystem',        icon: 'fs' },
  // components
  Processor:         { category: 'component', label: 'Processor',       icon: 'cpu' },
  Memory:            { category: 'component', label: 'Memory Module',   icon: 'memory' },
  PCIeDevice:        { category: 'component', label: 'Device (PCIe)',   icon: 'device' },
  // power & cooling
  PowerSupply:       { category: 'power',   label: 'Power Supply',      icon: 'power' },
  Fan:               { category: 'cooling', label: 'Fan',               icon: 'fan' },
  TemperatureSensor: { category: 'sensor',  label: 'Temperature Sensor',icon: 'temp' },
  // inventory
  Firmware:          { category: 'firmware', label: 'Firmware',         icon: 'chip' },
  Software:          { category: 'software', label: 'Software',         icon: 'package' },
};

// Relationship verbs used in the topology graph.
export const REL = {
  CONTAINS: 'contains',        // chassis contains server; server contains cpu
  RUNS_ON: 'runs_on',          // VM runs_on hypervisor
  CONNECTED_TO: 'connected_to',// interface connected_to interface (L2/L3)
  MANAGED_BY: 'managed_by',    // server managed_by BMC
  MEMBER_OF: 'member_of',      // host member_of cluster
};

// Edges that express physical/logical containment for the hierarchy tree.
export const CONTAINMENT_RELS = ['contains', 'managed_by'];

// Reconciliation identifier priority (highest → lowest confidence).
export const RECON_PRIORITY = ['serial', 'uuid', 'mac', 'mgmt_ip', 'hostname'];

export function isKnownType(t) {
  return Object.prototype.hasOwnProperty.call(CI_TYPES, t);
}
