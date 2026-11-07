package database_test

import (
	"testing"

	"github.com/hdjsjsdhdhhs-prog/dictatorvpn/internal/database"
	"github.com/hdjsjsdhdhhs-prog/dictatorvpn/internal/interfaces"
)

func TestCompileTimeInterfaceChecks(t *testing.T) {
	var _ interfaces.DatabaseService = (*database.Service)(nil)
}
