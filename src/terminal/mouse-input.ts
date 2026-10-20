import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

type InputSource = NodeJS.ReadableStream & {
    isTTY?: boolean;
    setRawMode?(enabled: boolean): unknown;
    unpipe(destination?: NodeJS.WritableStream): unknown;
    ref?(): unknown;
    unref?(): unknown;
};

export function createMouseInput(source: InputSource) {
    const decoder = new StringDecoder("utf8");
    let active = false;
    let disposed = false;

    const stdin = Object.assign(
        new Transform({
            readableObjectMode: true,
            transform(chunk: Buffer, _encoding, callback) {
                for (const part of decoder.write(chunk).split(/(\u001b\[<\d{1,3};\d{1,5};\d{1,5}[Mm])/)) {
                    if (part) this.push(part);
                }
                callback();
            },
            flush(callback) {
                const pending = decoder.end();
                if (pending) this.push(pending);
                callback();
            },
        }),
        {
            isTTY: source.isTTY,
            setRawMode: source.setRawMode
                ? (enabled: boolean) => {
                      if (disposed || enabled === active) return stdin;
                      source.setRawMode!(enabled);
                      active = enabled;
                      if (enabled) source.pipe(stdin, { end: false });
                      else {
                          source.unpipe(stdin);
                          source.pause();
                      }
                      return stdin;
                  }
                : undefined,
            ref() {
                source.ref?.();
                return stdin;
            },
            unref() {
                source.unref?.();
                return stdin;
            },
        },
    );

    return {
        stdin,
        dispose() {
            if (disposed) return;
            stdin.setRawMode?.(false);
            disposed = true;
            source.unpipe(stdin);
            source.pause();
            stdin.destroy();
        },
    };
}
