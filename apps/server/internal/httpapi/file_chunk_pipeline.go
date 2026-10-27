package httpapi

import "context"

// Four bounded reads overlap network round trips without buffering the whole
// file. Results are consumed in byte order. Cancel/failure stops queued work.
func pipelineFileChunks[T any](ctx context.Context, start, step int64, end *int64, read func(context.Context, int64) (T, error), consume func(int64, T) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type result struct {
		value T
		err   error
	}
	pending := map[int64]<-chan result{}
	next := start
	fill := func() {
		for len(pending) < 4 && next < *end {
			offset := next
			next += step
			ch := make(chan result, 1)
			pending[offset] = ch
			go func() { v, err := read(ctx, offset); ch <- result{v, err} }()
		}
	}
	fill()
	for offset := start; offset < *end; offset += step {
		var r result
		select {
		case <-ctx.Done():
			return ctx.Err()
		case r = <-pending[offset]:
		}
		delete(pending, offset)
		if r.err != nil {
			return r.err
		}
		if err := consume(offset, r.value); err != nil {
			return err
		}
		fill()
	}
	return nil
}
