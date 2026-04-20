-- Create the weave-media Storage bucket for durable image/PDF/audio
-- uploads. Private (signed-URL access only), 10MB per file, MIME
-- allowlist left open for now.
--
-- Path convention (enforced by RLS below): {user_id}/...
-- Users can only touch objects under their own user_id folder.
--
-- Down migration: delete the four policies by name, then
--   delete from storage.buckets where id = 'weave-media';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('weave-media', 'weave-media', false, 10485760, null)
on conflict (id) do nothing;

-- Storage RLS is scoped to the weave-media bucket. Path enforcement:
-- the first folder in the object name must equal auth.uid().
create policy "Users can read their own media"
  on storage.objects for select
  using (
    bucket_id = 'weave-media'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can insert their own media"
  on storage.objects for insert
  with check (
    bucket_id = 'weave-media'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can update their own media"
  on storage.objects for update
  using (
    bucket_id = 'weave-media'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can delete their own media"
  on storage.objects for delete
  using (
    bucket_id = 'weave-media'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
