import { ApiProperty } from '@nestjs/swagger';

/** One option of a LIFF list's venue-type dropdown. */
export class VenueTypeFacetDto {
  @ApiProperty({ example: 4 })
  id!: number;

  @ApiProperty({ example: 'โรงยิม' })
  name!: string;
}

/**
 * The filter options that accompany a paginated LIFF list (`CLIENT-PAGINATION-1`).
 *
 * 🔴 COMPUTED OVER THE SEARCHED SET, NOT OVER THE PAGE. Once a list is paginated, page 1 no longer
 * holds every category, so a dropdown derived from the rows on screen would silently lose options.
 * These follow `q` and the caller's ownership scope and IGNORE the type/status filters and the
 * page — picking a type never collapses the dropdown to that one type, and loading more never
 * changes it.
 *
 * ⚠️ A SIBLING OF `meta`, NEVER A FIELD INSIDE IT. `PaginationMetaDto` is one shared schema across
 * the admin lists too; growing it would change their generated types for a concern they do not have.
 */
export class ListFacetsDto {
  @ApiProperty({
    type: [VenueTypeFacetDto],
    description:
      'Venue categories present in the searched set, `name ASC, id ASC`. The client re-sorts labels with a Thai collator.',
  })
  venueTypes!: VenueTypeFacetDto[];
}
