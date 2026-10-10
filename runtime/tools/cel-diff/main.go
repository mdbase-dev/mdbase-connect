// cel-diff evaluates CEL expressions with cel-go and compares the results with
// mdbn-core's. Input: JSON lines {"expr": "...", "ours": <encoded result>}
// from `spec-conformance`'s sibling binary `cel-diff-gen`. Local tool only.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"cel.dev/cel-go/cel"
	"cel.dev/cel-go/common/types"
	"cel.dev/cel-go/common/types/ref"
	"cel.dev/cel-go/common/types/traits"
)

type caseLine struct {
	Expr string          `json:"expr"`
	Ours json.RawMessage `json:"ours"`
}

func main() {
	env, err := cel.NewEnv(cel.OptionalTypes(), cel.CrossTypeNumericComparisons(true))
	if err != nil {
		panic(err)
	}
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1<<20), 1<<24)
	total, mismatches := 0, 0
	kinds := map[string]int{}
	for in.Scan() {
		var c caseLine
		if err := json.Unmarshal(in.Bytes(), &c); err != nil {
			panic(err)
		}
		total++
		theirs := evaluate(env, c.Expr)
		var ours any
		_ = json.Unmarshal(c.Ours, &ours)
		oursText, _ := json.Marshal(ours)
		if inner, ok := strings.CutPrefix(theirs, `{"checker":`); ok {
			// The checker rejects: our error agrees, or our value must be the
			// runtime value.
			inner = strings.TrimSuffix(inner, "}")
			if strings.Contains(string(oursText), `"error"`) || string(oursText) == inner {
				continue
			}
			theirs = inner
		}
		if string(oursText) != theirs {
			mismatches++
			kind := classify(string(oursText), theirs)
			kinds[kind]++
			if kinds[kind] <= 5 {
				fmt.Printf("MISMATCH [%s] %s\n  ours:   %s\n  cel-go: %s\n", kind, c.Expr, oursText, theirs)
			}
		}
	}
	names := make([]string, 0, len(kinds))
	for k := range kinds {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		fmt.Printf("%6d  %s\n", kinds[k], k)
	}
	fmt.Printf("%d cases, %d mismatches\n", total, mismatches)
	if mismatches > 0 {
		os.Exit(1)
	}
}

func classify(ours, theirs string) string {
	oe, te := strings.Contains(ours, `"error"`), strings.Contains(theirs, `"error"`)
	switch {
	case strings.Contains(ours, `"compile"`) != strings.Contains(theirs, `"compile"`):
		return "compile vs not"
	case oe && !te:
		return "ours error, cel-go value"
	case te && !oe:
		return "cel-go error, ours value"
	default:
		return "different values"
	}
}

// evaluate returns cel-go's result. When the type checker rejects the
// expression, the result is `{"checker":true, ...}` with the unchecked runtime
// value: spec 10 makes checking optional, so an engine may reject the
// expression (any error) or evaluate it with the runtime semantics.
func evaluate(env *cel.Env, expr string) string {
	parsed, iss := env.Parse(expr)
	if iss.Err() != nil {
		return `{"compile":true}`
	}
	_, checkIss := env.Check(parsed)
	prg, err := env.Program(parsed)
	if err != nil {
		return `{"compile":true}`
	}
	out, _, err := prg.Eval(map[string]any{})
	var result string
	if err != nil || types.IsError(out) {
		result = `{"error":true}`
	} else {
		b, _ := json.Marshal(encode(out))
		result = string(b)
	}
	if checkIss.Err() != nil {
		return `{"checker":` + result + `}`
	}
	return result
}

// encode mirrors cel-diff-gen's encoding of mdbn-core values.
func encode(v ref.Val) any {
	switch x := v.(type) {
	case types.Null:
		return map[string]any{"null": true}
	case types.Bool:
		return map[string]any{"bool": bool(x)}
	case types.Int:
		return map[string]any{"int": strconv.FormatInt(int64(x), 10)}
	case types.Uint:
		return map[string]any{"uint": strconv.FormatUint(uint64(x), 10)}
	case types.Double:
		f := float64(x)
		switch {
		case math.IsNaN(f):
			return map[string]any{"double": "NaN"}
		case math.IsInf(f, 1):
			return map[string]any{"double": "+Inf"}
		case math.IsInf(f, -1):
			return map[string]any{"double": "-Inf"}
		}
		return map[string]any{"double": strconv.FormatUint(math.Float64bits(f), 16)}
	case types.String:
		return map[string]any{"string": string(x)}
	case types.Bytes:
		return map[string]any{"bytes": fmt.Sprintf("%x", []byte(x))}
	case types.Timestamp:
		return map[string]any{"timestamp": x.Time.UTC().Format(time.RFC3339Nano)}
	case types.Duration:
		return map[string]any{"duration": strconv.FormatInt(int64(x.Duration), 10)}
	case *types.Optional:
		if !x.HasValue() {
			return map[string]any{"optional": nil}
		}
		return map[string]any{"optional": encode(x.GetValue())}
	}
	if l, ok := v.(traits.Lister); ok && v.Type() == types.ListType {
		n := int64(l.Size().(types.Int))
		items := make([]any, 0, n)
		for i := int64(0); i < n; i++ {
			items = append(items, encode(l.Get(types.Int(i))))
		}
		return map[string]any{"list": items}
	}
	if m, ok := v.(traits.Mapper); ok {
		type kv struct {
			k string
			v any
		}
		var entries []kv
		it := m.Iterator()
		for it.HasNext() == types.True {
			k := it.Next()
			kb, _ := json.Marshal(encode(k))
			entries = append(entries, kv{string(kb), encode(m.Get(k))})
		}
		// Map order is not compared (spec note N33): sort by encoded key.
		sort.Slice(entries, func(i, j int) bool { return entries[i].k < entries[j].k })
		out := make([]any, 0, len(entries))
		for _, e := range entries {
			out = append(out, []any{json.RawMessage(e.k), e.v})
		}
		return map[string]any{"map": out}
	}
	return map[string]any{"other": v.Type().TypeName()}
}
