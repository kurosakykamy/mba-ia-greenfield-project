import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({}) as {
      value: { SWAGGER_ENABLED: string };
      error: unknown;
    };
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue (phase 03)', () => {
  it('should default storage and queue hosts to the Compose service names', () => {
    const { value, error } = validate({}) as {
      value: { STORAGE_ENDPOINT: string; REDIS_HOST: string };
      error: unknown;
    };
    expect(error).toBeUndefined();
    expect(value.STORAGE_ENDPOINT).toBe('http://storage:4566');
    expect(value.REDIS_HOST).toBe('redis');
  });

  it('should reject a multipart part size below the S3 minimum of 5 MiB', () => {
    const { error } = validate({ STORAGE_PART_SIZE_BYTES: '1048576' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_PART_SIZE_BYTES');
  });

  it('should accept the configured defaults for queue retry policy', () => {
    const { value, error } = validate({}) as {
      value: { QUEUE_JOB_ATTEMPTS: number; QUEUE_BACKOFF_DELAY_MS: number };
      error: unknown;
    };
    expect(error).toBeUndefined();
    expect(value.QUEUE_JOB_ATTEMPTS).toBe(3);
    expect(value.QUEUE_BACKOFF_DELAY_MS).toBe(5000);
  });
});
