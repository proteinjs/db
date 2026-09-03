import React from 'react';
import { useNavigate } from 'react-router-dom';
import { FormPage, Page, PageComponentProps, useFormFactor } from '@proteinjs/ui';
import { getDbService, tableByName } from '@proteinjs/db';
import { RecordForm } from '../form/RecordForm';
import { getRecordPanels, RecordPanel } from '../panel/RecordPanel';
import { RecordSurface } from '../panel/RecordSurface';
import { recordTableLink } from './RecordTablePage';
import { Box, Theme, SxProps, Typography } from '@mui/material';

export const recordFormPage: Page = {
  name: 'Record Form',
  path: 'record/form',
  auth: {
    allUsers: true,
  },
  // No height override: the app's page container owns viewport height (dvh on mobile —
  // a 100vh pin here clipped the bottom behind mobile browser chrome).
  pageContainerSxProps: (theme: Theme): SxProps => {
    return {
      backgroundColor: theme.palette.background.default,
    };
  },
  component: ({ ...props }) => <DynamicRecordForm {...props} />,
};

export const recordFormLink = (tableName: string, recordId: string) => {
  return `/${recordFormPage.path}?table=${tableName}&record=${recordId}`;
};

export const newRecordFormLink = (tableName: string) => {
  return `/${recordFormPage.path}?table=${tableName}`;
};

/**
 * The redirect a declaring table's stale form URL takes (see `Table.ui.recordTable.recordLink`):
 * renders nothing and replaces the history entry, so Back skips the URL that was never a page.
 *
 * It is its own component so the router dependency belongs to the tables that actually redirect
 * — the generic form path keeps rendering standalone, with no `<Router>` above it.
 */
const RecordLinkRedirect = ({ link }: { link: string }) => {
  const navigate = useNavigate();
  React.useEffect(() => {
    navigate(link, { replace: true });
  }, [link]);
  return null;
};

/**
 * The record page: ONE loader for the record and its declared panels (`RecordPanel`), one paint.
 *
 * Shell — phone (founder ruling 2026-08-31): the form takes the FULL mobile view under the
 * shell's chrome — no FormPage card, no page gutters; the page column scrolls the form itself.
 * The form keeps its own content inset (the card's inset was the only thing keeping fields off
 * the glass). Desktop keeps the house FormPage card. With panels declared for the current user,
 * the shell is `RecordSurface` (form + panels, placement derived from the viewport); without
 * panels this page renders exactly as it did before panels existed.
 */
const DynamicRecordForm = ({ urlParams }: PageComponentProps) => {
  const recordId = urlParams['record'];
  const { isPhone } = useFormFactor();
  /**
   * Tables whose rows have their OWN page (`Table.ui.recordTable.recordLink`) never render the
   * generic form. A stale `/record/form?table=<name>&record=<id>` URL — a bookmark, an old link,
   * the back button — replace-navigates to the declared link, built from the id ALONE so the
   * redirect never waits on (or fails with) a row load. A stale new-record URL (no `record`
   * param) has no row to point at, so it lands on the table.
   */
  const recordLink = getTable().table?.ui?.recordTable?.recordLink;
  const [record, setRecord] = React.useState<any>();
  const [panels, setPanels] = React.useState<RecordPanel[]>([]);
  const [panelData, setPanelData] = React.useState<{ [panelName: string]: unknown }>({});
  /**
   * The form renders differently for a new record than for an existing one (RecordFormCustomization
   * keys its buttons and fields off `record`), so an existing record must not be rendered until it
   * has loaded — otherwise the form briefly shows the create surface for a record that already
   * exists. New-record forms have nothing to wait for and start loaded. The same gate holds the
   * panels: the page paints the form and every panel's first-paint data TOGETHER, never a panel
   * arriving beside an already-painted form.
   */
  const [recordLoaded, setRecordLoaded] = React.useState(!recordId);
  const [loadError, setLoadError] = React.useState<string>();

  /**
   * The one loader: the record, then every visible panel's `load(record)`. `reload` (handed to
   * the panels) re-runs it — the record is refreshed IN PLACE (the form keeps its record
   * identity, exactly like a field renderer's reload) and every panel's data is re-read.
   */
  const load = async () => {
    const { table } = getTable();
    if (!table || !recordId) {
      return;
    }

    setRecordLoaded(false);
    setLoadError(undefined);
    try {
      const fetchedRecord = await getDbService().get(table, { id: recordId });
      const declared = fetchedRecord ? getRecordPanels(table.name) : [];
      const loaded = await Promise.all(
        declared.map(async (panel) => {
          try {
            return { panel, data: await panel.load(fetchedRecord) };
          } catch (error) {
            // A panel that cannot load its first-paint data does not paint — no spinner, no
            // half-panel beside a working form. Loud in the console, never a blank page.
            console.error(`Record panel '${panel.name}' failed to load and will not render`, error);
            return undefined;
          }
        })
      );
      const visible = loaded.filter((entry): entry is { panel: RecordPanel; data: unknown } => !!entry);
      if (record && fetchedRecord) {
        Object.assign(record, fetchedRecord);
      } else {
        setRecord(fetchedRecord);
      }
      setPanels(visible.map((entry) => entry.panel));
      const data: { [panelName: string]: unknown } = {};
      for (const entry of visible) {
        data[entry.panel.name] = entry.data;
      }
      setPanelData(data);
    } catch {
      setLoadError(`Unable to load ${table.name} record: ${recordId}`);
    }
    setRecordLoaded(true);
  };

  React.useEffect(() => {
    // A declaring table redirects instead of loading: the record it would fetch belongs to
    // another page, and the redirect needs nothing from the row.
    if (recordLink) {
      return;
    }

    load();
  }, [urlParams.table, urlParams.record]);

  function getTable() {
    const tableName = urlParams['table'];
    let table;
    let error;
    if (tableName) {
      try {
        table = tableByName(tableName);
      } catch {
        // NOTE: this catch previously bound the exception as `error`, shadowing the outer
        // variable — the message was never returned and the page rendered blank.
        error = `Table not accessible in UI: ${tableName}`;
      }
    } else {
      error = `Table name not provided via the 'table' url param`;
    }

    return { table, error };
  }

  function Message({ children }: { children: React.ReactNode }) {
    return <Typography sx={{ p: 3, color: 'text.secondary' }}>{children}</Typography>;
  }

  function Form() {
    const { table, error } = getTable();
    if (!table) {
      return <Message>{error}</Message>;
    }

    if (loadError) {
      return <Message>{loadError}</Message>;
    }

    if (!recordLoaded) {
      return null;
    }

    if (recordId && !record) {
      return <Message>{`No ${table.name} record found: ${recordId}`}</Message>;
    }

    return <RecordForm table={table} record={record} />;
  }

  if (recordLink) {
    const { table } = getTable();
    return <RecordLinkRedirect link={recordId ? recordLink({ id: recordId }) : recordTableLink(table!)} />;
  }

  const { table } = getTable();
  // Panels are declared per table and gated per viewer — known before the load resolves, so a
  // page that will paint the pair never first paints the lone form card in the pair's place.
  const declaresPanels = !!table && !!recordId && getRecordPanels(table.name).length > 0;
  if (declaresPanels && !loadError) {
    if (!recordLoaded) {
      return null;
    }

    if (record && panels.length > 0) {
      return <RecordSurface table={table} record={record} panels={panels} panelData={panelData} reload={load} />;
    }
  }

  if (isPhone) {
    return (
      <Box data-phone-fullbleed sx={{ flexGrow: 1, minHeight: 0, width: '100%', overflow: 'auto', padding: 2 }}>
        <Form />
      </Box>
    );
  }

  return (
    <FormPage>
      <Form />
    </FormPage>
  );
};
