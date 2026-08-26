const { loadServiceMap } = require('./config');

const ROLE_META = {
  virtual_consult_en: {
    consultationType: 'Virtual - English',
    pipeline: 'acquisition',
    outcomeDriver: 'hubspot_meeting_outcome',
    acquisitionOnly: true,
  },
  virtual_consult_es: {
    consultationType: 'Virtual - Spanish',
    pipeline: 'acquisition',
    outcomeDriver: 'hubspot_meeting_outcome',
    acquisitionOnly: true,
  },
  in_office_consult: {
    consultationType: 'In-Person',
    pipeline: 'acquisition',
    outcomeDriver: 'boulevard',
    acquisitionOnly: true,
  },
  first_session_100: {
    consultationType: null,
    pipeline: 'acquisition',
    outcomeDriver: 'boulevard',
    acquisitionOnly: true,
  },
};

function normalizeId(id) {
  return String(id || '').trim().toLowerCase();
}

function serviceMapById(map) {
  const byId = {};
  if (!map) return byId;
  for (const role of Object.keys(ROLE_META)) {
    const id = map[role];
    if (id) byId[normalizeId(id)] = role;
  }
  return byId;
}

function classifyServiceId(config, serviceId) {
  const { map } = loadServiceMap(config);
  const role = serviceMapById(map)[normalizeId(serviceId)] || null;
  if (!role) {
    return {
      role: null,
      serviceId: serviceId || null,
      consultationType: null,
      pipeline: 'treatment_journey',
      outcomeDriver: 'boulevard',
      acquisitionOnly: false,
    };
  }
  return {
    role,
    serviceId,
    ...ROLE_META[role],
  };
}

function classifyAppointmentServices(config, appointmentServices = []) {
  const classified = (appointmentServices || []).map((svc) => {
    const serviceId = svc.serviceId || svc.service?.id;
    return {
      appointmentServiceId: svc.id,
      serviceName: svc.service?.name || null,
      ...classifyServiceId(config, serviceId),
    };
  });
  const primary =
    classified.find((c) => c.acquisitionOnly) || classified[0] || null;
  return { primary, services: classified };
}

module.exports = {
  ROLE_META,
  classifyServiceId,
  classifyAppointmentServices,
};
