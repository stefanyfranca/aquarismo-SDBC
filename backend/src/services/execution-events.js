const { EventEmitter } = require('events');

const events = new EventEmitter();
events.setMaxListeners(100);

function publish(executionId, event, data) {
  events.emit(String(executionId), { event, data });
}

function subscribe(executionId, listener) {
  const channel = String(executionId);
  events.on(channel, listener);
  return () => events.off(channel, listener);
}

module.exports = { publish, subscribe };
