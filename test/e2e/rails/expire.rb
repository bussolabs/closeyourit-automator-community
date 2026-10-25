# frozen_string_literal: true

# Simulates the TTL elapsing after the daemon SIGKILL, without waiting 15 minutes.
# Operates only on the fixture ticket/host and only in the test database.
require "json"

abort "RAILS_ENV must be test" unless Rails.env.test?

metadata = JSON.parse(File.read(ENV.fetch("AUTOMATOR_E2E_METADATA")))
ticket_id = metadata.fetch("ticket_id")
host_ids = metadata.fetch("hosts").values.map { |host| host.fetch("id") }
expired_at = 1.second.ago

Agents::Lease.where(ticket_id: ticket_id, host_id: host_ids).update_all(expires_at: expired_at, updated_at: Time.current)
Agents::LimitReservation.where(host_id: host_ids).update_all(expires_at: expired_at, updated_at: Time.current)
