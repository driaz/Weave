-- Enable RLS on reasoning layer tables. With no policies defined,
-- these tables are accessible ONLY via the service role key (which
-- bypasses RLS). The anon and authenticated keys are denied all
-- operations. When the client-side "Reflect" surface ships, add
-- read policies for authenticated users at that time.

alter table weave_profile_snapshots enable row level security;
alter table weave_profile_cluster_embeddings enable row level security;
