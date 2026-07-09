import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * Fails when EVERY property of the validated object is `undefined` — i.e. an empty PATCH body.
 *
 * Why it inspects values and not keys (DD-12): `useDefineForClassFields` is effective under
 * `target: ES2023`, and `class-transformer` instantiates DTOs with `new targetType()`, so every
 * declared field exists on the instance. `Object.keys(dto).length` is therefore constant and
 * useless. `Object.values(dto).some(v => v !== undefined)` is the exact test.
 *
 * class-validator can only register a constraint on a property, so attach this to one field; the
 * resulting 400 body names that property. The message makes the real cause explicit.
 */
export function AtLeastOneDefined(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'atLeastOneDefined',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          return Object.values(args.object).some((v) => v !== undefined);
        },
        defaultMessage(): string {
          return 'At least one field must be provided.';
        },
      },
    });
  };
}
