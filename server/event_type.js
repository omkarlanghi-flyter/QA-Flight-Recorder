'use strict';

function getEventType(event) {
  if (!event || typeof event !== 'object') return '';
  const t = event.event_type || event.type || '';
  return typeof t === 'string' ? t : '';
}

function normalizeEventType(event) {
  if (!event || typeof event !== 'object') return event;
  const t = getEventType(event);
  if (!t) return event;
  if (event.event_type === t && event.type === t) return event;
  return { ...event, event_type: t, type: t };
}

function normalizeEventTypes(events) {
  if (!Array.isArray(events)) return [];
  return events.map(normalizeEventType);
}

module.exports = {
  getEventType,
  normalizeEventType,
  normalizeEventTypes,
};
