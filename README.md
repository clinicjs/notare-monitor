# notare-monitor -- Node.js observer

Extracted from the `notare` module, `notare-monitor` provides
a Node.js streams `Readable` that monitors and reports on
various Node.js performance metrics.

## Example

```js
const { Monitor } = require('notare-monitor');
const { pipeline, Writable } = require('stream');

class myWritable extends Writable {
  constructor() {
    super({ objectMode: true });
  }
  _write(chunk, encoding, callback) {
    console.log(JSON.stringify(chunk));
    callback();
  }
}

const monitor = new Monitor();
pipeline(monitor, new myWritable(), (err) => {
  if (err) {
    console.error('There was an error!');
    process.exit(1);
  }
});
```

## API

### Constructor:  `Monitor([options])`

Create a new `'Monitor` object.

* `options` (`object`)
  * `hz`: (`number`) An integer between 1 and 1000 that specifies the number
    of samples per second the `Monitor` should generate. The higher this
    number, the greater the performance impact the `Monitor` will have.
    The default is `2`. The `NOTARE_HZ` environment variable may also be
    used to set this value.
  * `handles`: (`boolean`) When true, the `Monitor` will track and report
    on the number of async resources in use by Node.js. Enabling this has
    a measurable performance impact on the Node.js process so it is off
    by default. Setting the `NOTARE_HANDLES` environment variable to `1`
    may also be used to set this value.
  * `gc`: (`boolean`) When true, the `Monitor` will track and report on
    garbage collection counts and durations. Enabling this has a
    measurable performance impact on the Node.js process so it is off
    by default. Setting the `NOTARE_GC` environment variable to `1`
    may also be used to set this value.

The `Monitor` object extends from Node.js [`stream.Readable`][].

## Configuration via Environment Variables

* `NOTARE_HZ=n` where `n` is the number of samples per second (default `2`)
* `NOTARE_HANDLES=1` instructs notare to monitor async hook handle counts
  (disabled by default)
* `NOTARE_GZ=1` instructs notare to monitor garbage collection (disabled
  by default)

[`stream.Readable`]: https://nodejs.org/dist/latest-v14.x/docs/api/stream.html#stream_readable_streams
