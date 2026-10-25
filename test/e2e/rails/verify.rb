# frozen_string_literal: true

# Exports only non-sensitive evidence: no token or credential store value enters the report.
require "json"

abort "RAILS_ENV must be test" unless Rails.env.test?

metadata = JSON.parse(File.read(ENV.fetch("AUTOMATOR_E2E_METADATA")))
ticket = Ticketing::Ticket.find(metadata.fetch("ticket_id"))
host_ids = metadata.fetch("hosts").values.map { |host| host.fetch("id") }

# Host-first (CYAU-90): the outcome of a phase is NO longer a per-agent run (`agent.runs`, legacy channel no longer
# fed by the queue), but an Agents::Attempt on the ticket workflow; a phase delivered and approved by the
# server has status `approved` (see Agents::Attempts::Deliver).
report = {
  ticket_status: ticket.status.code,
  ticket_comments: ticket.comments.order(:created_at).pluck(:body),
  attempt_statuses: ticket.agent_workflow&.attempts&.order(:created_at)&.map(&:status) || [],
  active_leases: Agents::Lease.where(ticket: ticket).where("expires_at > ?", Time.current).count,
  host_ids_seen: Agents::Host.where(id: host_ids).order(:hostname).pluck(:id)
}

output = ENV.fetch("AUTOMATOR_E2E_REPORT")
File.open(output, File::WRONLY | File::CREAT | File::EXCL, 0o600) do |file|
  file.write(JSON.generate(report))
  file.flush
  file.fsync
end
