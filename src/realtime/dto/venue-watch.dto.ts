import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * The payload of `venue:watch` / `venue:unwatch` on the `/client` namespace.
 *
 * 🔴 IT IS VALIDATED BY HAND, NOT BY THE GLOBAL `ValidationPipe`. The handler declares its body as
 * `unknown` (metatype `Object`), which the pipe skips by design — so `ClientRealtimeGateway` runs
 * `plainToInstance` + `validateSync` over this class itself. See the comment on its handlers for why
 * a deterministic ack beats a thrown exception on a socket.
 *
 * ⚠️ WHY VALIDATE AT ALL, when a bad `venueId` only produces a room nobody emits to: because this is
 * the ONLY inbound surface in the realtime module, and an unchecked value is concatenated into a
 * room name. `MaxLength` is the control that matters (an unbounded string becomes an unbounded map
 * key); `IsNotEmpty` stops a socket silently joining the bare `venue:` room. Existence of the venue
 * is deliberately NOT checked — that would make the socket an existence oracle for venue ids, and a
 * room for a venue that does not exist receives nothing anyway.
 *
 * The shape mirrors `CreateLineBookingDto.venueId` (trim · string · non-empty · ≤ 64) so the two
 * transports agree on what a venue id may look like.
 */
export class VenueWatchDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  venueId!: string;
}
