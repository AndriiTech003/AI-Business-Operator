const offset = Number(process.env.AIO_CLOCK_OFFSET_MS ?? '0');

if (Number.isFinite(offset) && offset !== 0) {
  const RealDate = globalThis.Date;
  class VirtualDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }

    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = VirtualDate;
}
