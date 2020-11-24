import { Readable } from 'stream';
import { threadId, isMainThread } from 'worker_threads';
import * as os from 'os';
import {
  monitorEventLoopDelay,
  EventLoopDelayMonitor,
  performance,
  PerformanceObserver,
  PerformanceObserverEntryList,
  PerformanceEntry
} from 'perf_hooks';
import {
  Sample,
  CpuSample,
  HandlesSample,
  GCSample
} from './common';
import { createHook, AsyncHook } from 'async_hooks';
import { version } from '../package.json';
import Histogram from 'native-hdr-histogram';

import debuglog from 'debug';

const debug = debuglog('notare');

interface MonitorOptions {
  hz? : number,
  handles? : boolean,
  gc? : boolean
}

interface FilledMonitorOptions extends MonitorOptions {
  hz : number,
  handles : boolean,
  gc: boolean
}

const kDefaultMonitorOptions : FilledMonitorOptions = {
  hz: parseInt(process.env.NOTARE_HZ || '0') || 2,
  handles: process.env.NOTARE_HANDLES === '1',
  gc: process.env.NOTARE_GC === '1'
};

type DestroyCallback = (err? : any) => void;

class HandleTracker {
  #types : Map<number, string> = new Map();
  #counts : Map<string, number> = new Map();
  #hook : AsyncHook;

  constructor () {
    const self : HandleTracker = this;
    this.#hook = createHook({
      init (id, type) {
        self.#types.set(id, type);

        if (!self.#counts.has(type)) {
          self.#counts.set(type, 1);
        } else {
          self.#counts.set(type, (self.#counts.get(type) || 0) + 1);
        }
      },
      destroy (id) {
        const type : string | undefined = self.#types.get(id);
        self.#types.delete(id);
        if (type !== undefined) {
          self.#counts.set(type, (self.#counts as any).get(type) - 1);
          if (self.#counts.get(type) === 0) {
            self.#counts.delete(type);
          }
        }
      }
    });
    this.#hook.enable();
  }

  get counts () : HandlesSample {
    const obj : HandlesSample = {
      titles: [],
      data: []
    };
    this.#counts.forEach((value : number, key : string) => {
      // Filter out out notare's handles
      if (key === 'UDPWRAP' ||
          key === 'Timeout' ||
          key === 'ELDHISTOGRAM') {
        value--;
      }
      if (value > 0) {
        obj.titles.push(key);
        obj.data.push(value);
      }
    });
    return obj;
  }

  destroy () {
    this.#hook.disable();
  }
}

class GCTracker {
  #obs : PerformanceObserver;
  #duration: any = new Histogram(1, 10000);
  #scavenges : number = 0;
  #sweeps : number = 0;
  #incremental : number = 0;
  #weakcbs : number = 0;

  constructor () {
    this.#obs = new PerformanceObserver(
      (list : PerformanceObserverEntryList) => {
        const entries = list.getEntries();
        entries.forEach((entry : PerformanceEntry) => {
          this.#duration.record(entry.duration);
          switch (entry.kind) {
            case 0: this.#scavenges++; break;
            case 1: this.#sweeps++; break;
            case 2: this.#incremental++; break;
            case 3: this.#weakcbs++; break;
          }
        });
      });

    this.#obs.observe({ entryTypes: ['gc'] });
  }

  get sample () : GCSample {
    return {
      scavenges: this.#scavenges,
      sweeps: this.#sweeps,
      incremental: this.#incremental,
      weakcbs: this.#weakcbs,
      duration: {
        min: this.#duration.min(),
        max: this.#duration.max(),
        mean: this.#duration.mean(),
        stddev: this.#duration.stddev(),
        p0_001: this.#duration.percentile(0.001),
        p0_01: this.#duration.percentile(0.01),
        p0_1: this.#duration.percentile(0.1),
        p1: this.#duration.percentile(1),
        p2_5: this.#duration.percentile(2.5),
        p10: this.#duration.percentile(10),
        p25: this.#duration.percentile(25),
        p50: this.#duration.percentile(50),
        p75: this.#duration.percentile(75),
        p90: this.#duration.percentile(90),
        p97_5: this.#duration.percentile(97.5),
        p99: this.#duration.percentile(99),
        p99_9: this.#duration.percentile(99.9),
        p99_99: this.#duration.percentile(99.99),
        p99_999: this.#duration.percentile(99.999)
      }
    } as GCSample;
  }
}

export class Monitor extends Readable {
  #options : MonitorOptions;
  #timer : any;
  #elmonitor? : EventLoopDelayMonitor;
  #lastTS : bigint;
  #lastCPUUsage? : NodeJS.CpuUsage;
  #handles? : HandleTracker;
  #gc? : GCTracker;

  constructor (options : MonitorOptions = {}) {
    super({
      objectMode: true
    } as any);

    if (options !== undefined &&
        (typeof options !== 'object' || options === null)) {
      throw new TypeError('options must be an object');
    }
    if (options.hz !== undefined) {
      if (typeof options.hz !== 'number') {
        throw new TypeError('options.hz must be a number between 1 and 1000');
      }
      if (options.hz < 1 || options.hz > 1000) {
        throw new RangeError('options.hz must be a number between 1 and 1000');
      }
    }
    if (options.handles !== undefined && typeof options.handles !== 'boolean') {
      throw new TypeError('options.handles must be a boolean');
    }

    this.#options = { ...kDefaultMonitorOptions, ...options };
    this.#lastTS = process.hrtime.bigint();

    const delay =
        Math.floor(1000 / (this.#options.hz || kDefaultMonitorOptions.hz));
    this._sample();
    this.#timer = setInterval(() => this._sample(), delay);
    if (monitorEventLoopDelay !== undefined) {
      this.#elmonitor = monitorEventLoopDelay({ resolution: delay });
      this.#elmonitor.enable();
    }
    this.#timer.unref();

    if (this.#options.handles) {
      this.#handles = new HandleTracker();
    }

    if (this.#options.gc) {
      this.#gc = new GCTracker();
    }

    debug(`rate: ${this.#options.hz} samples per second`);
    debug(`collecting handles? ${this.#options.handles ? 'yes' : 'no'}`);
  }

  _cpupct () {
    const now = process.hrtime.bigint();
    const elapsed = parseInt((now - this.#lastTS).toString()) / 1e6;
    const usage = this.#lastCPUUsage = process.cpuUsage(this.#lastCPUUsage);
    const total = (usage.user + usage.system) / 1e6;
    this.#lastTS = now;
    return total / elapsed;
  }

  _sample () {
    const memory = process.memoryUsage();
    const cpus = os.cpus();
    const loadAvg = os.loadavg();

    let idle, active, utilization;
    if (typeof (performance as any).eventLoopUtilization === 'function') {
      const util = (performance as any).eventLoopUtilization();
      idle = util.idle;
      active = util.active;
      utilization = util.utilization;
    }

    const sample : Sample = {
      pid: process.pid,
      threadId,
      isMainThread,
      memory: {
        arrayBuffers: memory.arrayBuffers,
        external: memory.external,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        rss: memory.rss
      },
      cpu: this._cpupct(),
      cpus: cpus.map((cpu) : CpuSample => {
        return {
          model: cpu.model,
          speed: cpu.speed,
          idle: cpu.times.idle,
          irq: cpu.times.irq,
          nice: cpu.times.nice,
          sys: cpu.times.sys,
          user: cpu.times.user
        };
      }),
      loadAvg: {
        a1: loadAvg[0],
        a5: loadAvg[1],
        a15: loadAvg[2]
      },
      eventLoop: undefined,
      handles: undefined,
      gc: undefined,
      loopUtilization: {
        idle,
        active,
        utilization
      }
    };

    if (this.#handles !== undefined) {
      sample.handles = this.#handles.counts;
    }

    if (this.#elmonitor !== undefined) {
      sample.eventLoop = {
        min: this.#elmonitor.min,
        max: this.#elmonitor.max,
        mean: this.#elmonitor.mean,
        stddev: this.#elmonitor.stddev,
        p0_001: this.#elmonitor.percentile(0.001),
        p0_01: this.#elmonitor.percentile(0.01),
        p0_1: this.#elmonitor.percentile(0.1),
        p1: this.#elmonitor.percentile(1),
        p2_5: this.#elmonitor.percentile(2.5),
        p10: this.#elmonitor.percentile(10),
        p25: this.#elmonitor.percentile(25),
        p50: this.#elmonitor.percentile(50),
        p75: this.#elmonitor.percentile(75),
        p90: this.#elmonitor.percentile(90),
        p97_5: this.#elmonitor.percentile(97.5),
        p99: this.#elmonitor.percentile(99),
        p99_9: this.#elmonitor.percentile(99.9),
        p99_99: this.#elmonitor.percentile(99.99),
        p99_999: this.#elmonitor.percentile(99.999)
      };
    }

    if (this.#gc !== undefined) {
      sample.gc = this.#gc.sample;
    }

    this.push(sample);
  }

  _destroy (err : any, callback : DestroyCallback) {
    this.push(null);
    if (this.#elmonitor !== undefined) {
      this.#elmonitor.disable();
    }
    if (this.#handles !== undefined) {
      this.#handles.destroy();
    }
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    callback(err);
  }

  _read () {
    // Nothing to do here
  }

  ref () : Monitor {
    this.#timer.ref();
    return this;
  }

  unref () : Monitor {
    this.#timer.unref();
    return this;
  }

  get options () : MonitorOptions {
    return this.#options;
  }

  static get version () : string {
    return version;
  }

  static get Monitor () {
    return Monitor;
  }
}

export {
  CpuSample,
  HandlesSample,
  HistogramSample,
  LoadAvgSample,
  MemorySample,
  Sample
} from './common';
