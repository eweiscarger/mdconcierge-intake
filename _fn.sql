CREATE OR REPLACE FUNCTION public.network_providers()
RETURNS json LANGUAGE sql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $function$
  select coalesce(json_agg(json_build_object(
    'id', p.id,
    'name', p.doctor_name,
    'specialty', p.specialty,
    'type', coalesce(p.provider_type,'Other'),
    'body_parts', p.body_parts,
    'practice', (select name from practices where id = p.practice_id),
    'states', p.states,
    'address', coalesce(nullif(p.location_address,''), (select address from practices where id=p.practice_id)),
    'category', case
      when coalesce(p.provider_type,'') ~* 'pharmac|rph' or coalesce(p.specialty,'') ~* 'pharmac' then 'Pharmacy'
      when coalesce(p.provider_type,'') ~* 'imaging|radiolog|mri' or coalesce(p.specialty,'') ~* 'imaging|radiolog|mri' then 'Imaging'
      when coalesce(p.provider_type,'') ~* 'physical therap|dpt' or coalesce(p.specialty,'') ~* 'physical therap|dpt' then 'Physical Therapy'
      else 'Specialist'
    end
  ) order by coalesce(p.provider_type,'Other'), p.doctor_name), '[]'::json)
  from providers p;
$function$
