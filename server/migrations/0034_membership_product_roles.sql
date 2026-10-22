-- Existing members retain their legacy role until an administrator explicitly scopes product access.
ALTER TABLE memberships ADD COLUMN product_roles jsonb;
ALTER TABLE memberships ADD CONSTRAINT memberships_product_roles_object CHECK(product_roles IS NULL OR jsonb_typeof(product_roles)='object');
