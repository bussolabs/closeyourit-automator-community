# frozen_string_literal: true

# Cross-repo fixture CYAU-56. Run exclusively with RAILS_ENV=test by
# `test/multi-host-e2e.test.ts`; the generated secrets stay in a temporary 0600 file.
require "factory_bot_rails"
require "json"

include FactoryBot::Syntax::Methods

output = ENV.fetch("AUTOMATOR_E2E_METADATA")
run_key = ENV.fetch("AUTOMATOR_E2E_RUN_KEY")

organization = create(:organization, name: "Automator E2E #{run_key}", slug: "automator-e2e-#{run_key}")
account = create(:account, email: "automator-e2e-#{run_key}@example.test", handle: "e2e#{run_key.delete('-')}")
create(:membership, account: account, organization: organization, role: :owner)

project = create(:project, organization: organization, key: "E2E", name: "Automator E2E")
create(
  :github_repository,
  project: project,
  full_name: "closeyourit/automator",
  default_branch: "main",
  sync_enabled: true
)

open_status = create(
  :ticket_status,
  organization: organization,
  code: "open",
  label: "Open",
  category: :open,
  position: 0
)
create(
  :ticket_status,
  :in_progress,
  organization: organization,
  code: "in_progress",
  label: "In Progress",
  position: 1
)
create(
  :ticket_status,
  :in_review,
  organization: organization,
  code: "in_review",
  label: "In Review",
  position: 2
)
create(
  :ticket_status,
  :done,
  organization: organization,
  code: "resolved",
  label: "Resolved",
  position: 3
)
priority = create(:ticket_priority, organization: organization, code: "high", label: "High", position: 10)

ticket = create(
  :ticket,
  :plain_bug,
  organization: organization,
  project: project,
  reporter: account,
  reviewer: account,
  status: open_status,
  priority: priority,
  title: "Provare il ciclo multi-host reale",
  description: "Un solo host deve implementare; il vincitore deve riprendere una delivery interrotta."
)

# Host-first (CYAU-90): the agent no longer carries a free `run` command — it uses the organizational command (triage by
# default from the factory). It serves only so that the automator knows the project has the queue enabled; the execution
# is decided by the claimed PHASE, not by the agent.
agent = create(
  :agent,
  organization: organization,
  slug: "ticket-cycle-e2e",
  name: "Ticket cycle E2E",
  schedule: "every 1s",
  timeout_seconds: 900,
  ticket_queue_enabled: true,
  catch_up: true,
  enabled: true
)
create(:agent_target, agent: agent, project: project)

org_token = Agents::Tokens::Issue.call(
  organization: organization,
  name: "bootstrap-#{run_key}",
  created_by: account
).value.fetch(:secret)
user_token = Accounts::ApiTokens::Issue.call(
  account: account,
  organization: organization,
  name: "e2e-#{run_key}"
).value.fetch(:secret)

hosts = %w[a b].to_h do |label|
  registered = Agents::Hosts::Register.call(
    organization: organization,
    fingerprint: "e2e-#{run_key}-#{label}",
    hostname: "e2e-host-#{label}",
    platform: RUBY_PLATFORM,
    arch: "test",
    automator_version: "e2e"
  ).value
  host = registered.fetch(:host)
  # Host-first (CYAU-90): a host claims only if CERTIFIED and with VISIBILITY on the project. Register mints the
  # host service account WITHOUT projects (fail-closed) → here we certify and grant the scope, like the claim specs.
  host.update!(
    certified_at: Time.current,
    last_heartbeat_at: Time.current,
    repositories: [ project.key ],
    runtimes: [ { "name" => "claude", "present" => true } ]
  )
  create(:project_membership, account: host.service_account, project: project)
  [label, {id: host.id, token: registered.fetch(:secret)}]
end

payload = {
  organization_id: organization.id,
  project_id: project.id,
  project_key: project.key,
  ticket_id: ticket.id,
  ticket_code: ticket.code,
  agent_id: agent.id,
  org_token: org_token,
  user_token: user_token,
  hosts: hosts
}

File.open(output, File::WRONLY | File::CREAT | File::EXCL, 0o600) do |file|
  file.write(JSON.generate(payload))
  file.flush
  file.fsync
end
